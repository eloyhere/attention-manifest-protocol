/**
 * SQLite adapter for `SocialStore`.
 *
 * Relationships and institutions are social facts, not message history; this
 * adapter maps them to their tables and never exposes rows to the domain.
 */
import type { DatabaseSync } from "node:sqlite";

import { AgentError } from "../../error/agentError.ts";
import type { Institution, Membership, Pid, Relationship, SocialStore } from "../../ipc/social.ts";
import { TableSql } from "../sql/sql.ts";
import { BaseRepository } from "./base.ts";
import { InstitutionTable, MembershipTable, RelationshipTable } from "../entity/agent.ts";
import type { InstitutionRow, MembershipRow, RelationshipRow } from "../entity/agent.ts";

/**
 * Row returned when asking SQLite for the next relationship id.
 */
type NextRelationshipIdRow = {
    n: number;
};

const parseJson: <T>(text: string, fallback: T) => T = <T>(text: string, fallback: T): T => {
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
};

const toInstitution: (row: InstitutionRow) => Institution = (row: InstitutionRow): Institution => ({
    id: row.id,
    name: row.name,
    norms: parseJson<string[]>(row.norms_json, []),
});

const toRelationship: (row: RelationshipRow) => Relationship = (row: RelationshipRow): Relationship => {
    const relationship: Relationship = {
        id: row.id,
        fromPid: row.from_pid,
        toPid: row.to_pid,
        kind: row.kind,
        trust: row.trust,
        attachment: row.attachment,
        obligations: parseJson<string[]>(row.obligations_json, []),
        since: row.since,
    };
    if (row.last_contact !== null) {
        relationship.lastContact = row.last_contact;
    }
    return relationship;
};

export class SocialRepository extends BaseRepository<InstitutionRow, number> implements SocialStore {
    private readonly relationshipsSql: TableSql<RelationshipRow>;
    private readonly membershipsSql: TableSql<MembershipRow>;

    constructor(db: DatabaseSync) {
        super(db, InstitutionTable);
        this.relationshipsSql = new TableSql(db, RelationshipTable);
        this.membershipsSql = new TableSql(db, MembershipTable);
    }

    relationships(pid: Pid): Relationship[] {
        return this.relationshipsSql.select({ where: "from_pid = ? OR to_pid = ?", params: [pid, pid], orderBy: "ORDER BY trust DESC" }).map(toRelationship);
    }

    memberships(pid: Pid): Membership[] {
        const rows: MembershipRow[] = this.membershipsSql.select({ where: "pid = ?", params: [pid] });
        const result: Membership[] = [];
        for (let index: number = 0; index < rows.length; index += 1) {
            const row: MembershipRow = rows[index];
            const institution: InstitutionRow | undefined = this.findById(row.iid);
            if (institution === (void 0)) {
                continue;
            }
            result.push({
                institution: toInstitution(institution),
                role: row.role,
                status: row.status as Membership["status"],
                since: row.since,
            });
        }
        return result;
    }

    institution(id: string): Institution | undefined {
        const row: InstitutionRow | undefined = this.queries.select({ where: "id = ?", params: [id], limit: 1 })[0];
        return row === (void 0) ? undefined : toInstitution(row);
    }

    upsertRelationship(input: Parameters<SocialStore["upsertRelationship"]>[0]): Relationship {
        const existing: RelationshipRow | undefined = this.relationshipsSql.select({
            where: "from_pid = ? AND to_pid = ? AND kind = ?",
            params: [input.fromPid, input.toPid, input.kind],
            limit: 1,
        })[0];
        if (existing === (void 0)) {
            const next: number = this.relationshipsSql.queryOne<NextRelationshipIdRow>("SELECT COALESCE(MAX(rel_id), 0) + 1 AS n FROM relationships")?.n ?? 1;
            this.relationshipsSql.insert({
                id: `rel.${next}`,
                from_pid: input.fromPid,
                to_pid: input.toPid,
                kind: input.kind,
                trust: input.trust ?? 0.5,
                attachment: input.attachment ?? 0.5,
                obligations_json: JSON.stringify(input.obligations ?? []),
                since: input.since,
                last_contact: input.lastContact ?? null,
            });
        } else {
            this.relationshipsSql.updateWhere(
                "rel_id = ?",
                {
                    trust: input.trust ?? existing.trust,
                    attachment: input.attachment ?? existing.attachment,
                    obligations_json: JSON.stringify(input.obligations ?? parseJson<string[]>(existing.obligations_json, [])),
                    last_contact: input.lastContact ?? existing.last_contact,
                },
                existing.rel_id,
            );
        }
        const row: RelationshipRow | undefined = this.relationshipsSql.select({
            where: "from_pid = ? AND to_pid = ? AND kind = ?",
            params: [input.fromPid, input.toPid, input.kind],
            limit: 1,
        })[0];
        if (row === (void 0)) {
            throw new AgentError("relationship_not_found", [`${input.fromPid}->${input.toPid}`]);
        }
        return toRelationship(row);
    }

    createInstitution(input: Parameters<SocialStore["createInstitution"]>[0]): Institution {
        if (this.institution(input.id) !== (void 0)) {
            throw new AgentError("institution_not_found", [`institution ${input.id} already exists`]);
        }
        this.queries.insert({ id: input.id, name: input.name, norms_json: JSON.stringify(input.norms ?? []) });
        const row: InstitutionRow | undefined = this.queries.select({ where: "id = ?", params: [input.id], limit: 1 })[0];
        if (row === (void 0)) {
            throw new AgentError("institution_not_found", [`institution ${input.id}`]);
        }
        return toInstitution(row);
    }

    joinInstitution(input: Parameters<SocialStore["joinInstitution"]>[0]): Membership {
        const institution: Institution | undefined = this.institution(input.institutionId);
        if (institution === (void 0)) {
            throw new AgentError("institution_not_found", [`institution ${input.institutionId}`]);
        }
        const row: InstitutionRow | undefined = this.queries.select({ where: "id = ?", params: [input.institutionId], limit: 1 })[0];
        if (row === (void 0)) {
            throw new AgentError("institution_not_found", [`institution ${input.institutionId}`]);
        }
        const existing: MembershipRow | undefined = this.membershipsSql.select({ where: "pid = ? AND iid = ?", params: [input.pid, row.iid], limit: 1 })[0];
        if (existing === (void 0)) {
            this.membershipsSql.insert({ pid: input.pid, iid: row.iid, role: input.role, status: "active", since: input.since });
        } else {
            this.membershipsSql.updateWhere("pid = ? AND iid = ?", { role: input.role, status: "active", since: input.since }, input.pid, row.iid);
        }
        return {
            institution,
            role: input.role,
            status: "active",
            since: input.since,
        };
    }

    leaveInstitution(pid: Pid, institutionId: string, at: string): Membership {
        const institution: Institution | undefined = this.institution(institutionId);
        if (institution === (void 0)) {
            throw new AgentError("institution_not_found", [`institution ${institutionId}`]);
        }
        const row: InstitutionRow | undefined = this.queries.select({ where: "id = ?", params: [institutionId], limit: 1 })[0];
        if (row === (void 0)) {
            throw new AgentError("institution_not_found", [`institution ${institutionId}`]);
        }
        const changed: number = this.membershipsSql.updateWhere("pid = ? AND iid = ?", { status: "left", since: at }, pid, row.iid);
        if (changed === 0) {
            throw new AgentError("institution_not_found", [`membership ${pid}/${institutionId}`]);
        }
        const membership: MembershipRow | undefined = this.membershipsSql.select({ where: "pid = ? AND iid = ?", params: [pid, row.iid], limit: 1 })[0];
        return { institution, role: membership?.role ?? "", status: "left", since: membership?.since ?? at };
    }
}
