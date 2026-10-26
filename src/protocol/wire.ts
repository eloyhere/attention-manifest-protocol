import type { Delegation, Lease } from "../delegate/team.ts";
import type { DelegationDoc, LeaseDoc } from "../cooperation/collaboration.ts";

/**
 * Wire mapping for collaboration objects.
 *
 * The runtime uses camelCase; the wire uses snake_case and stable names because
 * a delegation crosses domains and must not depend on an implementation's
 * internal naming. Round-tripping is tested, not assumed.
 */
export const toDelegationDoc: (delegation: Delegation) => DelegationDoc = (delegation: Delegation): DelegationDoc => {
    return {
        amp: "0.1",
        kind: "delegation",
        id: delegation.id,
        parent: delegation.parent,
        granter: delegation.granter,
        delegatee: delegation.delegatee,
        goal_digest: delegation.goalDigest,
        scope: delegation.scope,
        budget: delegation.budget,
        deadline: delegation.deadline,
        may_redelegate: delegation.mayRedelegate,
        depth: delegation.depth,
    };
};

export const fromDelegationDoc: (doc: DelegationDoc) => Delegation = (doc: DelegationDoc): Delegation => {
    const delegation: Delegation = {
        id: doc.id,
        granter: doc.granter,
        delegatee: doc.delegatee,
        goalDigest: doc.goal_digest,
        scope: doc.scope,
        budget: doc.budget,
        deadline: doc.deadline,
        mayRedelegate: doc.may_redelegate,
        depth: doc.depth,
    };
    if (doc.parent !== (void 0)) {
        delegation.parent = doc.parent;
    }
    return delegation;
};

export const toLeaseDoc: (lease: Lease) => LeaseDoc = (lease: Lease): LeaseDoc => {
    return {
        amp: "0.1",
        kind: "lease",
        id: lease.id,
        delegation: lease.delegation,
        task_id: lease.taskId,
        holder: lease.holder,
        fence: lease.fence,
        goal_digest: lease.goalDigest,
        budget: lease.budget,
        deadline: lease.deadline,
        status: lease.status,
    };
};
