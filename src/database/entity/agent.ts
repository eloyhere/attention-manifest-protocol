/**
 * Table metadata for agent facets and social facts.
 *
 * The rows are intentionally thin: domain types live in `src/process/agent.ts`
 * and `src/ipc/social.ts`; this file only maps columns. Rich JPA metadata
 * (`defineEntity`) is reserved for aggregate roots that need associations; the
 * child tables here are simple and are queried through `TableSql`.
 */
import type { TableMeta } from "./meta.ts";

export interface AgentProfileRow {
    pid: number;
    name: string;
    narrative: string;
    values_json: string;
    constraints_json: string;
    life_chapter: string;
    updated_at: string;
    version: number;
}

export const AgentProfileTable: TableMeta = {
    table: "person_profiles",
    primaryKey: "pid",
    columns: ["pid", "name", "narrative", "values_json", "constraints_json", "life_chapter", "updated_at", "version"],
};

export interface SelfNarrativeRow {
    snid: number;
    pid: number;
    version: number;
    identity_json: string;
    narrative: string;
    at: string;
    object_seq: number | null;
}

export const SelfNarrativeTable: TableMeta = {
    table: "self_narratives",
    primaryKey: "snid",
    columns: ["snid", "pid", "version", "identity_json", "narrative", "at", "object_seq"],
};

export interface RoleRow {
    rid: number;
    id: string;
    label: string;
    obligations_json: string;
    permissions_json: string;
    audiences_json: string;
    scripts_json: string;
    status: string;
    created_at: string;
}

export const RoleTable: TableMeta = {
    table: "roles",
    primaryKey: "rid",
    columns: ["rid", "id", "label", "obligations_json", "permissions_json", "audiences_json", "scripts_json", "status", "created_at"],
};

export interface PersonRoleRow {
    pid: number;
    rid: number;
    salience: number;
    active: number;
    since: string;
}

/** Composite key in schema; `pid` is only used as a selector here. */
export const PersonRoleTable: TableMeta = {
    table: "person_roles",
    primaryKey: "pid",
    columns: ["pid", "rid", "salience", "active", "since"],
};

export interface MemoryRow {
    mem_id: number;
    id: string;
    pid: number;
    role_id: string | null;
    kind: string;
    content: string;
    salience: number;
    at: string;
    refs_json: string;
    source: string | null;
    consolidated: number;
}

export const MemoryTable: TableMeta = {
    table: "memories",
    primaryKey: "mem_id",
    columns: ["mem_id", "id", "pid", "role_id", "kind", "content", "salience", "at", "refs_json", "source", "consolidated"],
};

export interface AffectRow {
    pid: number;
    valence: number;
    arousal: number;
    stress: number;
    fatigue: number;
    mood: string;
    updated_at: string;
}

export const AffectTable: TableMeta = {
    table: "affect_states",
    primaryKey: "pid",
    columns: ["pid", "valence", "arousal", "stress", "fatigue", "mood", "updated_at"],
};

export interface RelationshipRow {
    rel_id: number;
    id: string;
    from_pid: number;
    to_pid: number;
    kind: string;
    trust: number;
    attachment: number;
    obligations_json: string;
    since: string;
    last_contact: string | null;
}

export const RelationshipTable: TableMeta = {
    table: "relationships",
    primaryKey: "rel_id",
    columns: ["rel_id", "id", "from_pid", "to_pid", "kind", "trust", "attachment", "obligations_json", "since", "last_contact"],
};

export interface InstitutionRow {
    iid: number;
    id: string;
    name: string;
    norms_json: string;
}

export const InstitutionTable: TableMeta = {
    table: "institutions",
    primaryKey: "iid",
    columns: ["iid", "id", "name", "norms_json"],
};

export interface MembershipRow {
    pid: number;
    iid: number;
    role: string;
    status: string;
    since: string;
}

/** Composite key in schema; `pid` is only used as a selector here. */
export const MembershipTable: TableMeta = {
    table: "memberships",
    primaryKey: "pid",
    columns: ["pid", "iid", "role", "status", "since"],
};

export interface BackgroundRow {
    bpid: number;
    id: string;
    pid: number;
    kind: string;
    label: string;
    intensity: number;
    trigger: string | null;
    script: string | null;
    status: string;
    updated_at: string;
}

export const BackgroundTable: TableMeta = {
    table: "background_processes",
    primaryKey: "bpid",
    columns: ["bpid", "id", "pid", "kind", "label", "intensity", "trigger", "script", "status", "updated_at"],
};

export interface LifeEventRow {
    ev_id: number;
    id: string;
    pid: number;
    kind: string;
    summary: string;
    at: string;
    role_id: string | null;
    impact: number;
    narrative_version: number | null;
}

export const LifeEventTable: TableMeta = {
    table: "life_events",
    primaryKey: "ev_id",
    columns: ["ev_id", "id", "pid", "kind", "summary", "at", "role_id", "impact", "narrative_version"],
};
