/**
 * Agent facets: because a process is a person, identity belongs here.
 *
 * This is not a second lifecycle. `process.ts` owns the runtime state
 * (created/running/idle/suspended/terminated); this module owns the biography:
 * self narrative, roles, memories, affect, background processes and life
 * events. Storage adapters implement `AgentStore`.
 */
import type { Confidence, Id, Pid, Ref, Timestamp } from "../types/common.ts";

export type { Pid } from "../types/common.ts";

export type MemoryKind = "episodic" | "semantic" | "procedural" | "social" | "affective";
export type RoleStatus = "active" | "retired";
export type BackgroundKind = "habit" | "emotion" | "monitor" | "drive";
export type BackgroundStatus = "active" | "paused" | "retired";
export type LifeEventKind = "turning-point" | "role-transition" | "relationship" | "achievement" | "loss" | "insight" | "other";

export type AgentErrorCode =
    | "agent_not_found"
    | "profile_exists"
    | "role_not_found"
    | "role_not_assigned"
    | "memory_not_found"
    | "invalid_memory"
    | "invalid_affect"
    | "institution_not_found";

/** Summary of the current person; the narrative version is stored separately. */
export interface AgentProfile {
    pid: Pid;
    name: string;
    lifeChapter: string;
    values: string[];
    constraints: string[];
    version: number;
    updatedAt: Timestamp;
}

/** Append-only self narrative. `version` starts at 1 and only increases. */
export interface SelfNarrative {
    pid: Pid;
    version: number;
    identity: Record<string, unknown>;
    narrative: string;
    at: Timestamp;
    /** Object-store sequence when the narrative is hash-chained. */
    objectSeq?: number;
}

export interface Obligation {
    id: Id;
    statement: string;
    audience?: string;
    /** Obligation ids in other roles that cannot be satisfied together with this one. */
    conflictsWith?: Id[];
    weight?: Confidence;
}

export interface Role {
    id: Id;
    label: string;
    obligations: Obligation[];
    expectations: string[];
    audiences: string[];
    scripts: string[];
    status: RoleStatus;
    createdAt: Timestamp;
}

export interface RoleAssignment {
    role: Role;
    salience: number;
    active: boolean;
    since: Timestamp;
}

export interface Memory {
    id: Id;
    pid: Pid;
    roleId?: Id;
    kind: MemoryKind;
    content: string;
    /** Retrieval salience in [0, 1]; mutable metadata, not truth. */
    salience: number;
    at: Timestamp;
    /** Pointers into warrant/objects; a memory is not itself evidence. */
    refs: Ref[];
    source?: string;
    consolidated: boolean;
}

export interface AffectState {
    pid: Pid;
    /** [-1, 1] */
    valence: number;
    /** [0, 1] */
    arousal: number;
    /** [0, 1] */
    stress: number;
    /** [0, 1] */
    fatigue: number;
    mood: string;
    updatedAt: Timestamp;
}

export interface BackgroundProcess {
    id: Id;
    pid: Pid;
    kind: BackgroundKind;
    label: string;
    /** [0, 1] */
    intensity: number;
    trigger?: string;
    script?: string;
    status: BackgroundStatus;
    updatedAt: Timestamp;
}

export interface LifeEvent {
    id: Id;
    pid: Pid;
    kind: LifeEventKind;
    summary: string;
    at: Timestamp;
    roleId?: Id;
    /** [0, 1] */
    impact: number;
    narrativeVersion?: number;
}

export interface NewAgentProfile {
    pid: Pid;
    name: string;
    lifeChapter?: string;
    values?: string[];
    constraints?: string[];
    at: Timestamp;
}

export interface NewNarrative {
    pid: Pid;
    identity: Record<string, unknown>;
    narrative: string;
    at: Timestamp;
}

export interface NewRole {
    id: Id;
    label: string;
    obligations?: Obligation[];
    expectations?: string[];
    audiences?: string[];
    scripts?: string[];
    createdAt: Timestamp;
}

export interface AssignRoleInput {
    pid: Pid;
    roleId: Id;
    salience?: number;
    active?: boolean;
    since: Timestamp;
}

export interface ActivateRoleInput {
    pid: Pid;
    roleId: Id;
    at: Timestamp;
}

export interface NewMemory {
    pid: Pid;
    roleId?: Id;
    kind: MemoryKind;
    content: string;
    salience?: number;
    at: Timestamp;
    refs?: Ref[];
    source?: string;
}

export interface MemoryQuery {
    kind?: MemoryKind;
    roleId?: Id;
    minSalience?: number;
    before?: Timestamp;
    limit?: number;
    includeConsolidated?: boolean;
}

export interface AffectInput {
    valence?: number;
    arousal?: number;
    stress?: number;
    fatigue?: number;
    mood?: string;
}

export interface NewBackgroundProcess {
    pid: Pid;
    kind: BackgroundKind;
    label: string;
    intensity?: number;
    trigger?: string;
    script?: string;
    at: Timestamp;
}

export interface NewLifeEvent {
    pid: Pid;
    kind: LifeEventKind;
    summary: string;
    at: Timestamp;
    roleId?: Id;
    impact?: number;
    narrativeVersion?: number;
}

export interface AgentReader {
    profile(pid: Pid): AgentProfile | undefined;
    narrative(pid: Pid, version?: number): SelfNarrative | undefined;
    roles(pid: Pid): RoleAssignment[];
    activeRole(pid: Pid): RoleAssignment | undefined;
    memories(pid: Pid, query?: MemoryQuery): Memory[];
    affect(pid: Pid): AffectState | undefined;
    background(pid: Pid, status?: BackgroundStatus): BackgroundProcess[];
    lifeEvents(pid: Pid, limit?: number): LifeEvent[];
}

export interface AgentStore extends AgentReader {
    createProfile(input: NewAgentProfile): AgentProfile;
    reviseNarrative(input: NewNarrative): SelfNarrative;
    addRole(input: NewRole): Role;
    assignRole(input: AssignRoleInput): RoleAssignment;
    activateRole(input: ActivateRoleInput): RoleAssignment;
    remember(input: NewMemory): Memory;
    forget(pid: Pid, memoryId: Id): boolean;
    consolidate(pid: Pid, memoryIds: Id[], at: Timestamp): number;
    setAffect(pid: Pid, input: AffectInput, at: Timestamp): AffectState;
    addBackground(input: NewBackgroundProcess): BackgroundProcess;
    setBackgroundStatus(pid: Pid, id: Id, status: BackgroundStatus, at: Timestamp): BackgroundProcess;
    recordLifeEvent(input: NewLifeEvent): LifeEvent;
}

export type AgentEvent =
    | { type: "agent.created"; pid: Pid; at: Timestamp }
    | { type: "agent.narrative.revised"; pid: Pid; version: number; at: Timestamp }
    | { type: "agent.role.added"; pid: Pid; roleId: Id; at: Timestamp }
    | { type: "agent.role.assigned"; pid: Pid; roleId: Id; at: Timestamp }
    | { type: "agent.role.activated"; pid: Pid; roleId: Id; at: Timestamp }
    | { type: "agent.role.retired"; pid: Pid; roleId: Id; at: Timestamp }
    | { type: "agent.memory.recorded"; pid: Pid; memoryId: Id; at: Timestamp }
    | { type: "agent.memory.consolidated"; pid: Pid; memoryIds: Id[]; at: Timestamp }
    | { type: "agent.memory.forgotten"; pid: Pid; memoryId: Id; at: Timestamp }
    | { type: "agent.affect.changed"; pid: Pid; at: Timestamp }
    | { type: "agent.background.changed"; pid: Pid; backgroundId: Id; at: Timestamp }
    | { type: "agent.life_event.recorded"; pid: Pid; lifeEventId: Id; at: Timestamp };
