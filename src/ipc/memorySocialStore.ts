/**
 * In-memory reference implementation of `SocialStore`.
 *
 * Relationships are persistent ties; institutions are normative memberships.
 * A storage adapter implements the same port.
 */
import { AgentError } from "../error/agentError.ts";
import type { Institution, JoinInstitutionInput, Membership, NewInstitution, NewRelationship, Pid, Relationship, SocialStore } from "./social.ts";

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class InMemorySocialStore implements SocialStore {
    private readonly relationshipRows = new Map<string, Relationship>();
    private readonly institutions = new Map<string, Institution>();
    private readonly membershipRows = new Map<Pid, Map<string, Membership>>();
    private nextRelationship = 1;

    relationships(pid: Pid): Relationship[] {
        return [...this.relationshipRows.values()]
            .filter((row) => row.fromPid === pid || row.toPid === pid)
            .map((row) => ({ ...row, obligations: [...row.obligations] }));
    }

    memberships(pid: Pid): Membership[] {
        return [...(this.membershipRows.get(pid)?.values() ?? [])].map((membership) => ({
            ...membership,
            institution: { ...membership.institution, norms: [...membership.institution.norms] },
        }));
    }

    institution(id: string): Institution | undefined {
        const institution = this.institutions.get(id);
        return institution === undefined ? undefined : { ...institution, norms: [...institution.norms] };
    }

    upsertRelationship(input: NewRelationship): Relationship {
        const key = `${input.fromPid}:${input.toPid}:${input.kind}`;
        const existing = this.relationshipRows.get(key);
        const relationship: Relationship = {
            id: existing?.id ?? `rel.${this.nextRelationship}`,
            fromPid: input.fromPid,
            toPid: input.toPid,
            kind: input.kind,
            trust: clamp01(input.trust ?? 0.5),
            attachment: clamp01(input.attachment ?? 0.5),
            obligations: [...(input.obligations ?? [])],
            since: input.since,
            lastContact: input.lastContact,
        };
        if (existing === undefined) this.nextRelationship += 1;
        this.relationshipRows.set(key, relationship);
        return { ...relationship, obligations: [...relationship.obligations] };
    }

    createInstitution(input: NewInstitution): Institution {
        if (this.institutions.has(input.id)) throw new AgentError("institution_not_found", [`institution ${input.id} already exists`]);
        const institution: Institution = { id: input.id, name: input.name, norms: [...(input.norms ?? [])] };
        this.institutions.set(institution.id, institution);
        return { ...institution, norms: [...institution.norms] };
    }

    joinInstitution(input: JoinInstitutionInput): Membership {
        const institution = this.institutions.get(input.institutionId);
        if (institution === undefined) throw new AgentError("institution_not_found", [`institution ${input.institutionId}`]);
        const membership: Membership = {
            institution: { ...institution, norms: [...institution.norms] },
            role: input.role,
            status: "active",
            since: input.since,
        };
        const rows = this.membershipRows.get(input.pid) ?? new Map<string, Membership>();
        rows.set(input.institutionId, membership);
        this.membershipRows.set(input.pid, rows);
        return membership;
    }

    leaveInstitution(pid: Pid, institutionId: string, at: string): Membership {
        const rows = this.membershipRows.get(pid);
        const membership = rows?.get(institutionId);
        if (rows === undefined || membership === undefined) {
            throw new AgentError("institution_not_found", [`membership ${pid}/${institutionId}`]);
        }
        membership.status = "left";
        membership.since = at;
        return membership;
    }
}
