/**
 * Agent service: the use-cases of a person, expressed only through ports.
 *
 * `createAgent` is the only place that touches the execution boundary: it asks
 * the execution port for a pid, then creates the profile, default role, first
 * self narrative and neutral affect state.
 */
import type { Budget, Id, Timestamp } from "../types/common.ts";
import type {
    ActivateRoleInput,
    AffectInput,
    AffectState,
    AgentProfile,
    AgentReader,
    AgentStore,
    AssignRoleInput,
    BackgroundProcess,
    BackgroundStatus,
    LifeEvent,
    Memory,
    MemoryQuery,
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
import type { Institution, JoinInstitutionInput, Membership, NewInstitution, NewRelationship, Relationship, SocialReader, SocialStore } from "../ipc/social.ts";
import type { AgentContext, AgentContextAssembler, AgentContextOptions } from "../context/agentContext.ts";
import { assembleAgentContext } from "../context/agentContext.ts";

export interface AgentExecutionPort {
    createProcess(input: { id: Id; name: string; at: Timestamp }): { pid: Pid };
}

export interface CreateAgentInput {
    /** Process id used by the execution layer; required when no port is wired. */
    id: Id;
    /** Supply only when the caller already created the process. */
    pid?: Pid;
    name: string;
    lifeChapter?: string;
    values?: string[];
    constraints?: string[];
    narrative?: string;
    identity?: Record<string, unknown>;
    at: Timestamp;
}

export interface CreateAgentResult {
    pid: Pid;
    profile: AgentProfile;
    narrative: SelfNarrative;
    role: RoleAssignment;
}

export class AgentService implements AgentContextAssembler {
    readonly agents: AgentStore;
    readonly social: SocialStore;
    private readonly execution?: AgentExecutionPort;

    constructor(agents: AgentStore, social: SocialStore, execution?: AgentExecutionPort) {
        this.agents = agents;
        this.social = social;
        this.execution = execution;
    }

    createAgent(input: CreateAgentInput): CreateAgentResult {
        const pid: Pid = input.pid ?? this.execution?.createProcess({ id: input.id, name: input.name, at: input.at }).pid ?? Number.NaN;
        if (!Number.isSafeInteger(pid) || pid <= 0) {
            throw new Error("AgentService.createAgent needs a pid or an AgentExecutionPort");
        }
        const profile: AgentProfile = this.agents.createProfile({
            pid,
            name: input.name,
            lifeChapter: input.lifeChapter,
            values: input.values,
            constraints: input.constraints,
            at: input.at,
        });
        const role: Role = this.agents.addRole({
            id: `role.self.${pid}`,
            label: "self",
            obligations: [],
            expectations: [],
            audiences: [],
            scripts: [],
            createdAt: input.at,
        });
        const assignment: RoleAssignment = this.agents.assignRole({ pid, roleId: role.id, salience: 1, active: true, since: input.at });
        const narrative: SelfNarrative = this.agents.reviseNarrative({
            pid,
            identity: input.identity ?? { name: input.name },
            narrative: input.narrative ?? `I am ${input.name}. I am at the beginning of a life chapter.`,
            at: input.at,
        });
        this.agents.setAffect(pid, { valence: 0, arousal: 0, stress: 0, fatigue: 0, mood: "neutral" }, input.at);
        return { pid, profile, narrative, role: assignment };
    }

    reviseNarrative(pid: Pid, narrative: string, identity: Record<string, unknown>, at: Timestamp): SelfNarrative {
        const input: NewNarrative = { pid, identity, narrative, at };
        return this.agents.reviseNarrative(input);
    }

    addRole(input: NewRole): Role {
        return this.agents.addRole(input);
    }

    assignRole(input: AssignRoleInput): RoleAssignment {
        return this.agents.assignRole(input);
    }

    activateRole(input: ActivateRoleInput): RoleAssignment {
        return this.agents.activateRole(input);
    }

    remember(input: NewMemory): Memory {
        return this.agents.remember(input);
    }

    recall(pid: Pid, query: MemoryQuery = {}): Memory[] {
        return this.agents.memories(pid, query);
    }

    setAffect(pid: Pid, input: AffectInput, at: Timestamp): AffectState {
        return this.agents.setAffect(pid, input, at);
    }

    addBackground(input: NewBackgroundProcess): BackgroundProcess {
        return this.agents.addBackground(input);
    }

    setBackgroundStatus(pid: Pid, id: Id, status: BackgroundStatus, at: Timestamp): BackgroundProcess {
        return this.agents.setBackgroundStatus(pid, id, status, at);
    }

    recordLifeEvent(input: NewLifeEvent): LifeEvent {
        return this.agents.recordLifeEvent(input);
    }

    relate(input: NewRelationship): Relationship {
        return this.social.upsertRelationship(input);
    }

    createInstitution(input: NewInstitution): Institution {
        return this.social.createInstitution(input);
    }

    joinInstitution(input: JoinInstitutionInput): Membership {
        return this.social.joinInstitution(input);
    }

    leaveInstitution(pid: Pid, institutionId: Id, at: Timestamp): Membership {
        return this.social.leaveInstitution(pid, institutionId, at);
    }

    relationships(pid: Pid): Relationship[] {
        return this.social.relationships(pid);
    }

    memberships(pid: Pid): Membership[] {
        return this.social.memberships(pid);
    }

    /**
     * Roles are social positions, so conflict is an obligation-level fact, not
     * a permission error. This is intentionally a read-only diagnostic.
     */
    roleConflicts(pid: Pid): Array<{ left: Role; right: Role; obligation: string; other: string }> {
        const assignments = this.agents.roles(pid);
        const conflicts: Array<{ left: Role; right: Role; obligation: string; other: string }> = [];
        for (let leftIndex = 0; leftIndex < assignments.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < assignments.length; rightIndex += 1) {
                const left = assignments[leftIndex].role;
                const right = assignments[rightIndex].role;
                for (const obligation of left.obligations) {
                    for (const other of right.obligations) {
                        if (obligation.conflictsWith?.includes(other.id) === true || other.conflictsWith?.includes(obligation.id) === true) {
                            conflicts.push({ left, right, obligation: obligation.id, other: other.id });
                        }
                    }
                }
            }
        }
        return conflicts;
    }

    assemble(pid: Pid, budget: Budget, options?: AgentContextOptions): AgentContext {
        return assembleAgentContext(this.agents, this.social, pid, budget, options);
    }

    context(pid: Pid, budget: Budget, options?: AgentContextOptions): AgentContext {
        return this.assemble(pid, budget, options);
    }

    reader(): AgentReader {
        return this.agents;
    }

    socialReader(): SocialReader {
        return this.social;
    }
}
