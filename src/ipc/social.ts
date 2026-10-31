/**
 * Social facts: relationships and institutions are not message history.
 *
 * Relationships are persistent trust/attachment/obligation structures between
 * agents; institutions are normative memberships. Both are read by the agent
 * context assembler and must be capability-scoped at the adapter layer.
 */
import type { Id, Pid, Timestamp } from "../types/common.ts";

export type { Pid } from "../types/common.ts";

export type MembershipStatus = "active" | "left";

export interface Relationship {
    id: Id;
    fromPid: Pid;
    toPid: Pid;
    kind: string;
    /**
     * [0, 1]
     */
    trust: number;
    /**
     * [0, 1]
     */
    attachment: number;
    obligations: string[];
    since: Timestamp;
    lastContact?: Timestamp;
}

export interface Institution {
    id: Id;
    name: string;
    norms: string[];
}

export interface Membership {
    institution: Institution;
    role: string;
    status: MembershipStatus;
    since: Timestamp;
}

export interface NewRelationship {
    fromPid: Pid;
    toPid: Pid;
    kind: string;
    trust?: number;
    attachment?: number;
    obligations?: string[];
    since: Timestamp;
    lastContact?: Timestamp;
}

export interface NewInstitution {
    id: Id;
    name: string;
    norms?: string[];
}

export interface JoinInstitutionInput {
    pid: Pid;
    institutionId: Id;
    role: string;
    since: Timestamp;
}

export interface SocialReader {
    relationships(pid: Pid): Relationship[];
    memberships(pid: Pid): Membership[];
    institution(id: Id): Institution | undefined;
}

export interface SocialStore extends SocialReader {
    upsertRelationship(input: NewRelationship): Relationship;
    createInstitution(input: NewInstitution): Institution;
    joinInstitution(input: JoinInstitutionInput): Membership;
    leaveInstitution(pid: Pid, institutionId: Id, at: Timestamp): Membership;
}

export type SocialEvent =
    | {
          type: "social.relationship.updated";
          relationshipId: Id;
          at: Timestamp;
      }
    | {
          type: "social.membership.changed";
          pid: Pid;
          institutionId: Id;
          at: Timestamp;
      };
