/**
 * Capability-based authorization.
 *
 * A logical process has no MMU, so isolation is a policy decision: by default a
 * subject may touch only its own resources, and any cross-subject access needs a
 * live capability row. Capabilities are attenuating (rights and expiry can only
 * shrink), recursive (revoking a parent revokes its grants) and auditable (every
 * grant/revoke appends an event to the object chain).
 */
import type { DatabaseSync } from "node:sqlite";

import type { Id } from "../types/common.ts";
import { AuthzError } from "../error/authzError.ts";
import { putObject } from "../database/store/database.ts";

export type SubjectKind = "host" | "process" | "thread";

export interface Subject {
    kind: SubjectKind;
    id: Id;
    pid?: number;
    tid?: number;
}

export type Action = "read" | "write" | "append" | "grant" | "revoke" | "spawn" | "kill" | "send" | "receive" | "fork" | "join";

export type ResourceKind = "object" | "process" | "thread" | "mailbox" | "budget";

export interface Resource {
    kind: ResourceKind;
    id: Id;
    /** The process that owns the resource; omitted for kernel/global objects. */
    ownerPid?: number;
}

export interface CapabilityRecord {
    hid: number;
    id: Id;
    subject: Subject;
    resource: Resource;
    rights: Action[];
    scope: "process" | "thread" | "shared";
    parentHid?: number;
    expiresAt?: string;
    revokedAt?: string;
    grantedBy?: Id;
    createdAt: string;
}

export interface GrantInput {
    grantor: Subject;
    grantee: Subject;
    resource: Resource;
    rights: Action[];
    scope?: "process" | "thread" | "shared";
    expiresAt?: string;
}

interface HandleRow {
    hid: number;
    id: string;
    subject_kind: SubjectKind;
    subject_id: string;
    subject_pid: number | null;
    resource_kind: ResourceKind;
    resource_id: string;
    owner_pid: number | null;
    rights: string;
    scope: "process" | "thread" | "shared";
    parent_hid: number | null;
    expires_at: string | null;
    revoked_at: string | null;
    granted_by: string | null;
    created_at: string;
}

const AllActions: readonly Action[] = ["read", "write", "append", "grant", "revoke", "spawn", "kill", "send", "receive", "fork", "join"];

const toCapability = (row: HandleRow): CapabilityRecord => {
    const subject: Subject = { kind: row.subject_kind, id: row.subject_id };
    if (row.subject_pid !== null) subject.pid = row.subject_pid;
    const resource: Resource = { kind: row.resource_kind, id: row.resource_id };
    if (row.owner_pid !== null) resource.ownerPid = row.owner_pid;
    const capability: CapabilityRecord = {
        hid: row.hid,
        id: row.id,
        subject,
        resource,
        rights: JSON.parse(row.rights) as Action[],
        scope: row.scope,
        createdAt: row.created_at,
    };
    if (row.parent_hid !== null) capability.parentHid = row.parent_hid;
    if (row.expires_at !== null) capability.expiresAt = row.expires_at;
    if (row.revoked_at !== null) capability.revokedAt = row.revoked_at;
    if (row.granted_by !== null) capability.grantedBy = row.granted_by;
    return capability;
};

const live = (row: HandleRow, at: string): boolean => row.revoked_at === null && (row.expires_at === null || row.expires_at > at);

const rowsFor = (db: DatabaseSync, subject: Subject, resource: Resource, at: string): HandleRow[] => {
    const subjects: Subject[] = [subject];
    // A thread also acts with the capabilities of its process (fds are shared).
    if (subject.kind === "thread" && subject.pid !== undefined) {
        subjects.push({ kind: "process", id: `p.${subject.pid}`, pid: subject.pid });
    }
    const rows: HandleRow[] = [];
    for (const candidate of subjects) {
        const found = db
            .prepare(
                `SELECT * FROM handles
                 WHERE subject_kind = ? AND subject_id = ?
                   AND resource_kind = ? AND resource_id = ?
                 ORDER BY hid ASC`,
            )
            .all(candidate.kind, candidate.id, resource.kind, resource.id) as unknown as HandleRow[];
        rows.push(...found.filter((row) => live(row, at)));
    }
    if (subject.kind === "thread" && subject.pid !== undefined) {
        const inherited = db
            .prepare(
                `SELECT * FROM handles
                 WHERE subject_kind = 'process' AND subject_pid = ?
                   AND resource_kind = ? AND resource_id = ?
                 ORDER BY hid ASC`,
            )
            .all(subject.pid, resource.kind, resource.id) as unknown as HandleRow[];
        rows.push(...inherited.filter((row) => live(row, at)));
    }
    return rows;
};

const isOwner = (subject: Subject, resource: Resource): boolean => resource.ownerPid !== undefined && subject.pid === resource.ownerPid;

/** Rights the subject actually holds on the resource, including ownership. */
export const effectiveRights = (db: DatabaseSync, subject: Subject, resource: Resource, at: string): Action[] => {
    if (subject.kind === "host" || isOwner(subject, resource)) return [...AllActions];
    const rights = new Set<Action>();
    for (const row of rowsFor(db, subject, resource, at)) {
        for (const right of JSON.parse(row.rights) as Action[]) rights.add(right);
    }
    return [...rights];
};

export const can = (db: DatabaseSync, subject: Subject, action: Action, resource: Resource, at: string): boolean => {
    return effectiveRights(db, subject, resource, at).includes(action);
};

/** Throws unless the subject holds `action` on `resource`. */
export const requirePermission = (db: DatabaseSync, subject: Subject, action: Action, resource: Resource, at: string): void => {
    if (can(db, subject, action, resource, at)) return;
    throw new AuthzError("permission_denied", [`${subject.kind}:${subject.id} may not ${action} ${resource.kind}:${resource.id}`]);
};

export const listCapabilities = (db: DatabaseSync, subject: Subject): CapabilityRecord[] => {
    const rows = db
        .prepare("SELECT * FROM handles WHERE subject_kind = ? AND subject_id = ? ORDER BY hid ASC")
        .all(subject.kind, subject.id) as unknown as HandleRow[];
    return rows.map(toCapability);
};

/**
 * Grant a subset of the grantor's rights to another subject.
 *
 * Amplification is rejected in both dimensions the model cares about: no new
 * right may appear, and the new expiry may not outlive the grantor's own.
 */
export const grant = (db: DatabaseSync, input: GrantInput, at: string): CapabilityRecord => {
    if (input.rights.length === 0) throw new AuthzError("invalid_grant", ["rights must not be empty"]);
    if (input.grantee.kind === "host") throw new AuthzError("invalid_grant", ["cannot grant to host"]);
    requirePermission(db, input.grantor, "grant", input.resource, at);

    const available: Action[] = effectiveRights(db, input.grantor, input.resource, at);
    const amplified: Action[] = input.rights.filter((right) => !available.includes(right));
    if (amplified.length > 0) {
        throw new AuthzError("rights_amplification", [`grantor does not hold ${amplified.join(", ")}`]);
    }

    const source = rowsFor(db, input.grantor, input.resource, at).find((row) => (JSON.parse(row.rights) as Action[]).includes("grant"));
    const sourceExpiry: string | undefined = source?.expires_at ?? undefined;
    if (sourceExpiry !== undefined && (input.expiresAt === undefined || input.expiresAt > sourceExpiry)) {
        throw new AuthzError("expiry_amplification", [`grant expires after the grantor's capability (${sourceExpiry})`]);
    }

    const count = db.prepare("SELECT COUNT(*) AS n FROM handles").get() as { n: number };
    const hid: number = count.n + 1;
    const id: Id = `h.${hid}`;
    const scope = input.scope ?? (input.grantee.kind === "thread" ? "thread" : "process");
    const result = db
        .prepare(
            `INSERT INTO handles
             (id, subject_kind, subject_id, subject_pid, resource_kind, resource_id, owner_pid, rights, scope, parent_hid, expires_at, granted_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            id,
            input.grantee.kind,
            input.grantee.id,
            input.grantee.pid ?? null,
            input.resource.kind,
            input.resource.id,
            input.resource.ownerPid ?? null,
            JSON.stringify(input.rights),
            scope,
            source?.hid ?? null,
            input.expiresAt ?? null,
            input.grantor.id,
            at,
        );
    const row = db.prepare("SELECT * FROM handles WHERE hid = ?").get(Number(result.lastInsertRowid)) as unknown as HandleRow;
    putObject(
        db,
        "event",
        `ev.authz.grant.${row.hid}`,
        {
            amp: "0.1",
            kind: "event",
            id: `ev.authz.grant.${row.hid}`,
            at,
            actor: { kind: input.grantor.kind === "host" ? "self" : "agent", id: input.grantor.id },
            type: "authz.granted",
            payload: { capability: id, grantee: input.grantee.id, resource: input.resource, rights: input.rights },
        },
        at,
    );
    return toCapability(row);
};

/** Revoke a capability and every grant derived from it. */
export const revoke = (db: DatabaseSync, subject: Subject, hid: number, at: string): number => {
    const row = db.prepare("SELECT * FROM handles WHERE hid = ?").get(hid) as unknown as HandleRow | undefined;
    if (row === undefined) throw new AuthzError("unknown_capability", [`hid ${hid}`]);
    const capability = toCapability(row);
    requirePermission(db, subject, "revoke", capability.resource, at);
    const result = db
        .prepare(
            `WITH RECURSIVE tree(hid) AS (
               SELECT ?
               UNION ALL
               SELECT h.hid FROM handles h JOIN tree t ON h.parent_hid = t.hid
             )
             UPDATE handles SET revoked_at = ?
             WHERE hid IN (SELECT hid FROM tree) AND revoked_at IS NULL`,
        )
        .run(hid, at);
    const count: number = Number(result.changes);
    if (count === 0) return 0;
    putObject(
        db,
        "event",
        `ev.authz.revoke.${hid}.${count}`,
        {
            amp: "0.1",
            kind: "event",
            id: `ev.authz.revoke.${hid}.${count}`,
            at,
            actor: { kind: "self", id: subject.id },
            type: "authz.revoked",
            payload: { capability: hid, revoked: count },
        },
        at,
    );
    return count;
};
