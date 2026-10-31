/**
 * Responsibility assignment ledger.
 *
 * One object answers "who is accountable for which duty, under what authority,
 * budget and window, and what evidence discharges it". The ledger owns the
 * lifecycle; `docs/schemas/responsibility.schema.json` owns the wire shape.
 *
 * Invariants deliberately mirror `src/delegate/team.ts`:
 * authority, budget, window and depth only shrink; an assignment cannot become
 * active without acceptance; the same duty cannot have two active owners; and
 * conflicting duties cannot be held by one assignee over overlapping windows.
 */
import type { Budget, Digest, Id, Ref, Signature, Timestamp } from "../types/common.ts";
import { digestOf } from "../semantic/canonical.ts";
import type {
    AssignmentAcceptance,
    AssignmentEvent,
    AssignmentEvidence,
    AssignmentStatus,
    AssignmentWindow,
    Duty,
    Raci,
    ResponsibilityAssignment,
} from "./types.ts";
import type { AssignmentCode } from "./errors.ts";
import { AssignmentError } from "./errors.ts";
import { authorityWithin, budgetWithin, BudgetDimensions, dutyConflict, windowWithin, windowsOverlap } from "./guards.ts";

export interface AssignmentLedgerOptions {
    now: () => Timestamp;
    /**
     * Called once per revoked assignment, including cascaded children. Hosts
     * use it to revoke interaction bindings and leases that cite the assignment.
     */
    onRevoke?: (assignment: ResponsibilityAssignment) => void;
}

export interface AssignmentPolicy {
    authority?: string[];
    budget?: Budget;
    window?: AssignmentWindow;
    maxDepth?: number;
    /**
     * Duty ids that require the assigner and assignee to be different parties
     * and the accountable party not to be the assigner.
     */
    independentDuties?: Id[];
}

export interface CreateAssignmentInput {
    id: Id;
    assigner: Id;
    assignee: Id;
    role?: string;
    duties: Duty[];
    raci?: Raci;
    authority: string[];
    budget: Budget;
    window: AssignmentWindow;
    parent?: Id;
    acceptance?: AssignmentAcceptance;
    evidence?: AssignmentEvidence;
    out_of_scope?: string[];
    delegable?: boolean;
    depth?: number;
    why: string;
    created?: Timestamp;
    signatures?: Signature[];
}

export interface DutyConflictRecord {
    left: Id;
    right: Id;
    duty: Id;
    other: Id;
    assignee: Id;
}

const fail: (code: AssignmentCode, problems: readonly string[]) => never = (code: AssignmentCode, problems: readonly string[]): never => {
    throw new AssignmentError(code, problems);
};

const clone: <T>(value: T) => T = <T>(value: T): T => structuredClone(value);

const seal: (assignment: ResponsibilityAssignment) => ResponsibilityAssignment = (assignment: ResponsibilityAssignment): ResponsibilityAssignment => {
    const body: Record<string, unknown> = { ...assignment };
    delete body.digest;
    delete body.signatures;
    assignment.digest = digestOf(body);
    return assignment;
};

const normalizeAcceptance: (input?: AssignmentAcceptance) => AssignmentAcceptance = (input?: AssignmentAcceptance): AssignmentAcceptance => {
    if (input === (void 0)) {
        return { required: true, state: "pending" };
    }
    return {
        required: input.required,
        state: input.state,
        ...(input.by === (void 0) ? {} : { by: input.by }),
        ...(input.at === (void 0) ? {} : { at: input.at }),
        ...(input.digest === (void 0) ? {} : { digest: input.digest }),
        ...(input.note === (void 0) ? {} : { note: input.note }),
    };
};

const validateDuties: (duties: readonly Duty[]) => void = (duties: readonly Duty[]): void => {
    if (duties.length === 0) {
        fail("assignment_invalid", ["at least one duty is required"]);
    }
    const seen: Set<Id> = new Set<Id>();
    for (let index: number = 0; index < duties.length; index += 1) {
        const duty: Duty = duties[index];
        if (duty.id.length === 0) {
            fail("assignment_invalid", ["a duty id must not be empty"]);
        }
        if (seen.has(duty.id)) {
            fail("assignment_invalid", [`duplicate duty ${duty.id}`]);
        }
        seen.add(duty.id);
        if (duty.statement.trim().length === 0) {
            fail("assignment_invalid", [`duty ${duty.id} has an empty statement`]);
        }
        if (duty.acceptance.length === 0) {
            fail("assignment_invalid", [`duty ${duty.id} needs at least one acceptance criterion`]);
        }
        if ((duty.conflicts_with ?? []).includes(duty.id)) {
            fail("assignment_invalid", [`duty ${duty.id} conflicts with itself`]);
        }
    }
};

const validateAuthority: (authority: readonly string[]) => void = (authority: readonly string[]): void => {
    const seen: Set<string> = new Set<string>();
    for (let index: number = 0; index < authority.length; index += 1) {
        const action: string = authority[index];
        if (action.length === 0) {
            fail("assignment_invalid", ["authority actions must not be empty"]);
        }
        if (seen.has(action)) {
            fail("assignment_invalid", [`duplicate authority ${action}`]);
        }
        seen.add(action);
    }
};

const validateBudget: (budget: Budget) => void = (budget: Budget): void => {
    for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
        const dimension: keyof Budget = BudgetDimensions[index];
        const value: number | undefined = budget[dimension];
        if (value !== (void 0) && (!Number.isFinite(value) || value < 0)) {
            fail("assignment_invalid", [`budget ${dimension} must be a finite non-negative number`]);
        }
    }
};

const validateWindow: (window: AssignmentWindow) => void = (window: AssignmentWindow): void => {
    const from: number = Date.parse(window.from);
    const to: number = Date.parse(window.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        fail("assignment_invalid", ["window must be a valid interval with from < to"]);
    }
};

const validateRaci: (input: CreateAssignmentInput, independent: readonly Id[]) => void = (
    input: CreateAssignmentInput,
    independent: readonly Id[],
): void => {
    const raci: Raci | undefined = input.raci;
    if (raci === (void 0)) {
        return;
    }
    const accountable: Id = raci.accountable;
    if (accountable !== input.assigner && accountable !== input.assignee) {
        fail("accountable_not_party", [`${accountable} is neither the assigner nor the assignee`]);
    }
    if (raci.responsible.length === 0) {
        fail("assignment_invalid", ["raci.responsible must not be empty"]);
    }
    const requiresIndependence: boolean = input.duties.some((duty: Duty): boolean => independent.includes(duty.id));
    if (requiresIndependence) {
        if (input.assigner === input.assignee) {
            fail("self_approval", ["an independent duty cannot be self-assigned"]);
        }
        if (accountable === input.assigner) {
            fail("self_approval", ["the assigner cannot be the accountable party of an independent duty"]);
        }
    }
};

export class AssignmentLedger {
    private readonly assignments: Map<Id, ResponsibilityAssignment> = new Map<Id, ResponsibilityAssignment>();
    private readonly eventLog: AssignmentEvent[] = [];
    private readonly now: () => Timestamp;
    private readonly onRevoke?: (assignment: ResponsibilityAssignment) => void;

    constructor(options: AssignmentLedgerOptions) {
        if (typeof(options.now) !== "function") {
            throw new TypeError("AssignmentLedger requires a clock");
        }
        this.now = options.now;
        this.onRevoke = options.onRevoke;
    }

    create(input: CreateAssignmentInput, policy: AssignmentPolicy = {}): ResponsibilityAssignment {
        if (input.id.length === 0) {
            fail("assignment_invalid", ["an assignment id must not be empty"]);
        }
        if (this.assignments.has(input.id)) {
            fail("assignment_invalid", [`assignment ${input.id} already exists`]);
        }
        if (input.assigner.length === 0 || input.assignee.length === 0) {
            fail("assignment_invalid", ["assigner and assignee must not be empty"]);
        }
        if (input.why.trim().length === 0) {
            fail("assignment_invalid", ["why must not be empty"]);
        }
        validateDuties(input.duties);
        validateAuthority(input.authority);
        validateBudget(input.budget);
        validateWindow(input.window);
        validateRaci(input, policy.independentDuties ?? []);

        let depth: number = input.depth ?? 0;
        if (depth < 0 || depth > 2) {
            fail("depth_exceeded", [`depth ${depth} exceeds 2`]);
        }
        if (input.parent !== (void 0)) {
            const parent: ResponsibilityAssignment | undefined = this.assignments.get(input.parent);
            if (parent === (void 0)) {
                throw new AssignmentError("parent_unavailable", [`unknown parent ${input.parent}`]);
            }
            if (!parent.delegable) {
                fail("depth_exceeded", [`${parent.id} is not delegable`]);
            }
            if (parent.status !== "active" && parent.status !== "accepted") {
                fail("parent_unavailable", [`parent ${parent.id} is ${parent.status}`]);
            }
            depth = parent.depth + 1;
            if (depth > 2) {
                fail("depth_exceeded", [`depth ${depth} exceeds 2`]);
            }
            if (!authorityWithin(input.authority, parent.authority)) {
                fail("authority_widened", [`authority exceeds ${parent.id}`]);
            }
            if (!budgetWithin(input.budget, parent.budget)) {
                fail("budget_widened", [`budget exceeds ${parent.id}`]);
            }
            if (!windowWithin(input.window, parent.window)) {
                fail("window_widened", [`window exceeds ${parent.id}`]);
            }
        }
        if (policy.authority !== (void 0) && !authorityWithin(input.authority, policy.authority)) {
            fail("authority_widened", ["authority exceeds the assigner policy"]);
        }
        if (policy.budget !== (void 0) && !budgetWithin(input.budget, policy.budget)) {
            fail("budget_widened", ["budget exceeds the assigner policy"]);
        }
        if (policy.window !== (void 0) && !windowWithin(input.window, policy.window)) {
            fail("window_widened", ["window exceeds the assigner policy"]);
        }
        if (policy.maxDepth !== (void 0) && depth > policy.maxDepth) {
            fail("depth_exceeded", [`depth ${depth} exceeds policy ${policy.maxDepth}`]);
        }

        const created: Timestamp = input.created ?? this.now();
        const dutyEvidence: string[] = [];
        for (let index: number = 0; index < input.duties.length; index += 1) {
            const required: readonly string[] = input.duties[index].evidence_required ?? [];
            for (let requiredIndex: number = 0; requiredIndex < required.length; requiredIndex += 1) {
                if (!dutyEvidence.includes(required[requiredIndex])) {
                    dutyEvidence.push(required[requiredIndex]);
                }
            }
        }
        const evidenceRequired: string[] = [...new Set<string>([...(input.evidence?.required ?? []), ...dutyEvidence])];
        const evidenceProduced: Ref[] = (input.evidence?.produced ?? []).map((ref: Ref) => ({ ...ref }));
        const acceptance: AssignmentAcceptance = normalizeAcceptance(input.acceptance);
        if (acceptance.state === "accepted" && acceptance.by !== input.assignee) {
            fail("acceptance_missing", ["acceptance must name the assignee"]);
        }
        const assignment: ResponsibilityAssignment = {
            amp: "0.1",
            kind: "responsibility-assignment",
            id: input.id,
            version: 1,
            ...(input.parent === (void 0) ? {} : { parent: input.parent }),
            assigner: input.assigner,
            assignee: input.assignee,
            ...(input.role === (void 0) ? {} : { role: input.role }),
            duties: input.duties.map((duty: Duty): Duty => ({
                id: duty.id,
                statement: duty.statement,
                scope: [...duty.scope],
                acceptance: duty.acceptance.map((criterion) => ({ ...criterion })),
                ...(duty.evidence_required === (void 0) ? {} : { evidence_required: [...duty.evidence_required] }),
                ...(duty.conflicts_with === (void 0) ? {} : { conflicts_with: [...duty.conflicts_with] }),
                ...(duty.delegable === (void 0) ? {} : { delegable: duty.delegable }),
            })),
            ...(input.raci === (void 0)
                ? {}
                : {
                      raci: {
                          accountable: input.raci.accountable,
                          responsible: [...input.raci.responsible],
                          ...(input.raci.consulted === (void 0) ? {} : { consulted: [...input.raci.consulted] }),
                          ...(input.raci.informed === (void 0) ? {} : { informed: [...input.raci.informed] }),
                      },
                  }),
            authority: [...input.authority],
            budget: { ...input.budget },
            window: { ...input.window },
            acceptance,
            evidence: { required: evidenceRequired, produced: evidenceProduced },
            ...(input.out_of_scope === (void 0) ? {} : { out_of_scope: [...input.out_of_scope] }),
            delegable: input.delegable ?? false,
            depth,
            status: "proposed",
            why: input.why,
            created,
            ...(input.signatures === (void 0) ? {} : { signatures: input.signatures.map((signature) => ({ ...signature })) }),
        };

        this.assertSingleAccountable(assignment);
        this.assertNoDutyConflict(assignment);
        this.assignments.set(assignment.id, seal(assignment));
        this.record("assignment.proposed", assignment, input.assigner, created, input.why);
        return clone(assignment);
    }

    accept(id: Id, by: Id, at: Timestamp, digest?: Digest): ResponsibilityAssignment {
        const assignment: ResponsibilityAssignment = this.require(id);
        this.requireStatus(assignment, ["proposed"], "accept");
        if (by !== assignment.assignee) {
            fail("assignment_invalid", [`${by} is not the assignee of ${id}`]);
        }
        this.assertSingleAccountable(assignment);
        this.assertNoDutyConflict(assignment);
        assignment.acceptance = {
            ...(assignment.acceptance ?? { required: true }),
            state: "accepted",
            by,
            at,
            ...(digest === (void 0) ? {} : { digest }),
        };
        assignment.status = "accepted";
        seal(assignment);
        this.record("assignment.accepted", assignment, by, at);
        return clone(assignment);
    }

    decline(id: Id, by: Id, at: Timestamp, reason: string): ResponsibilityAssignment {
        const assignment: ResponsibilityAssignment = this.require(id);
        this.requireStatus(assignment, ["proposed"], "decline");
        if (by !== assignment.assignee) {
            fail("assignment_invalid", [`${by} is not the assignee of ${id}`]);
        }
        if (reason.trim().length === 0) {
            fail("assignment_invalid", ["a decline needs a reason"]);
        }
        assignment.acceptance = {
            ...(assignment.acceptance ?? { required: true }),
            state: "declined",
            by,
            at,
            note: reason,
        };
        assignment.status = "declined";
        seal(assignment);
        this.record("assignment.declined", assignment, by, at, reason);
        return clone(assignment);
    }

    activate(id: Id, at: Timestamp): ResponsibilityAssignment {
        const assignment: ResponsibilityAssignment = this.require(id);
        this.requireStatus(assignment, ["proposed", "accepted"], "activate");
        if (assignment.acceptance !== (void 0) && assignment.acceptance.state === "declined") {
            fail("acceptance_denied", [`${id} was declined`]);
        }
        if (assignment.acceptance !== (void 0) && assignment.acceptance.state === "accepted" && assignment.acceptance.by !== assignment.assignee) {
            fail("acceptance_missing", [`${id} was not accepted by its assignee`]);
        }
        if (assignment.acceptance !== (void 0) && assignment.acceptance.required && assignment.acceptance.state !== "accepted") {
            fail("acceptance_missing", [`${id} has not been accepted`]);
        }
        if (Date.parse(at) < Date.parse(assignment.window.from)) {
            fail("window_not_started", [`${id} starts at ${assignment.window.from}`]);
        }
        if (assignment.parent !== (void 0)) {
            const parent: ResponsibilityAssignment | undefined = this.assignments.get(assignment.parent);
            if (parent === (void 0) || parent.status !== "active") {
                fail("parent_unavailable", [`parent ${assignment.parent} is not active`]);
            }
        }
        this.assertSingleAccountable(assignment);
        this.assertNoDutyConflict(assignment);
        assignment.status = "active";
        seal(assignment);
        this.record("assignment.activated", assignment, assignment.assigner, at);
        return clone(assignment);
    }

    block(id: Id, by: Id, at: Timestamp, reason: string): ResponsibilityAssignment {
        const assignment: ResponsibilityAssignment = this.require(id);
        this.requireStatus(assignment, ["active"], "block");
        if (by !== assignment.assigner && by !== assignment.assignee) {
            fail("assignment_invalid", [`${by} is not a party of ${id}`]);
        }
        if (reason.trim().length === 0) {
            fail("assignment_invalid", ["a block needs a reason"]);
        }
        assignment.status = "blocked";
        seal(assignment);
        this.record("assignment.blocked", assignment, by, at, reason);
        return clone(assignment);
    }

    resume(id: Id, by: Id, at: Timestamp): ResponsibilityAssignment {
        const assignment: ResponsibilityAssignment = this.require(id);
        this.requireStatus(assignment, ["blocked"], "resume");
        if (by !== assignment.assigner) {
            fail("assignment_invalid", [`${by} cannot resume ${id}`]);
        }
        assignment.status = "active";
        seal(assignment);
        this.record("assignment.resumed", assignment, by, at);
        return clone(assignment);
    }

    discharge(id: Id, by: Id, at: Timestamp, produced: readonly Ref[]): ResponsibilityAssignment {
        const assignment: ResponsibilityAssignment = this.require(id);
        this.requireStatus(assignment, ["active"], "discharge");
        if (by !== assignment.assigner && by !== assignment.assignee) {
            fail("assignment_invalid", [`${by} is not a party of ${id}`]);
        }
        const required: string[] = assignment.evidence?.required ?? [];
        const evidence: Ref[] = produced.map((ref: Ref) => ({ ...ref }));
        const missing: string[] = required.filter((kind: string): boolean => !evidence.some((ref: Ref): boolean => ref.kind === kind || ref.label === kind));
        if (missing.length > 0) {
            fail("evidence_missing", [`missing evidence: ${missing.join(", ")}`]);
        }
        assignment.evidence = {
            required: [...required],
            produced: [...(assignment.evidence?.produced ?? []), ...evidence],
        };
        assignment.status = "discharged";
        seal(assignment);
        this.record("assignment.discharged", assignment, by, at);
        return clone(assignment);
    }

    breach(id: Id, by: Id, at: Timestamp, reason: string): ResponsibilityAssignment {
        const assignment: ResponsibilityAssignment = this.require(id);
        this.requireStatus(assignment, ["active", "blocked"], "breach");
        if (reason.trim().length === 0) {
            fail("assignment_invalid", ["a breach needs a reason"]);
        }
        assignment.status = "breached";
        seal(assignment);
        this.record("assignment.breached", assignment, by, at, reason);
        return clone(assignment);
    }

    revoke(id: Id, by: Id, at: Timestamp, reason: string): ResponsibilityAssignment {
        const root: ResponsibilityAssignment = this.require(id);
        if (root.status === "revoked" || root.status === "discharged" || root.status === "expired" || root.status === "declined") {
            fail("status_transition", [`${id} is ${root.status} and cannot be revoked`]);
        }
        if (reason.trim().length === 0) {
            fail("assignment_invalid", ["a revoke needs a reason"]);
        }
        const stack: Id[] = [id];
        while (stack.length > 0) {
            const current: Id | undefined = stack.pop();
            if (current === (void 0)) {
                continue;
            }
            const assignment: ResponsibilityAssignment | undefined = this.assignments.get(current);
            if (assignment === (void 0)) {
                continue;
            }
            if (assignment.status === "revoked" || assignment.status === "discharged" || assignment.status === "expired" || assignment.status === "declined") {
                continue;
            }
            assignment.status = "revoked";
            seal(assignment);
            this.record("assignment.revoked", assignment, by, at, reason);
            this.onRevoke?.(clone(assignment));
            for (const child of this.assignments.values()) {
                if (child.parent === current) {
                    stack.push(child.id);
                }
            }
        }
        return clone(this.require(id));
    }

    expire(id: Id, at: Timestamp): ResponsibilityAssignment {
        const assignment: ResponsibilityAssignment = this.require(id);
        if (Date.parse(at) <= Date.parse(assignment.window.to)) {
            fail("status_transition", [`${id} is not past its window`]);
        }
        this.requireStatus(assignment, ["proposed", "accepted", "active", "blocked"], "expire");
        assignment.status = "expired";
        seal(assignment);
        this.record("assignment.expired", assignment, "system", at);
        return clone(assignment);
    }

    /**
     * Expire every non-terminal assignment whose window has elapsed. Returns
     * snapshots so a host can emit one audit record per expiry.
     */
    sweep(at: Timestamp): ResponsibilityAssignment[] {
        const expired: ResponsibilityAssignment[] = [];
        for (const assignment of this.assignments.values()) {
            if (
                assignment.status !== "proposed" &&
                assignment.status !== "accepted" &&
                assignment.status !== "active" &&
                assignment.status !== "blocked"
            ) {
                continue;
            }
            if (Date.parse(at) <= Date.parse(assignment.window.to)) {
                continue;
            }
            assignment.status = "expired";
            seal(assignment);
            this.record("assignment.expired", assignment, "system", at);
            expired.push(clone(assignment));
        }
        return expired;
    }

    get(id: Id): ResponsibilityAssignment {
        return clone(this.require(id));
    }

    find(id: Id): ResponsibilityAssignment | undefined {
        const assignment: ResponsibilityAssignment | undefined = this.assignments.get(id);
        return assignment === (void 0) ? undefined : clone(assignment);
    }

    list(): ResponsibilityAssignment[] {
        return [...this.assignments.values()].map((assignment: ResponsibilityAssignment): ResponsibilityAssignment => clone(assignment));
    }

    children(id: Id): ResponsibilityAssignment[] {
        return [...this.assignments.values()]
            .filter((assignment: ResponsibilityAssignment): boolean => assignment.parent === id)
            .map((assignment: ResponsibilityAssignment): ResponsibilityAssignment => clone(assignment));
    }

    events(): AssignmentEvent[] {
        return this.eventLog.map((event: AssignmentEvent): AssignmentEvent => clone(event));
    }

    coverage(dutyIds: readonly Id[]): { assigned: Id[]; unassigned: Id[] } {
        const covered: Set<Id> = new Set<Id>();
        for (const assignment of this.assignments.values()) {
            if (assignment.status !== "active") {
                continue;
            }
            for (const duty of assignment.duties) {
                covered.add(duty.id);
            }
        }
        return {
            assigned: dutyIds.filter((id: Id): boolean => covered.has(id)),
            unassigned: dutyIds.filter((id: Id): boolean => !covered.has(id)),
        };
    }

    conflicts(): DutyConflictRecord[] {
        const active: ResponsibilityAssignment[] = [...this.assignments.values()].filter(
            (assignment: ResponsibilityAssignment): boolean => assignment.status === "active",
        );
        const found: DutyConflictRecord[] = [];
        for (let leftIndex: number = 0; leftIndex < active.length; leftIndex += 1) {
            for (let rightIndex: number = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
                const left: ResponsibilityAssignment = active[leftIndex];
                const right: ResponsibilityAssignment = active[rightIndex];
                if (left.assignee !== right.assignee || !windowsOverlap(left.window, right.window)) {
                    continue;
                }
                for (const leftDuty of left.duties) {
                    for (const rightDuty of right.duties) {
                        if (dutyConflict(leftDuty, rightDuty)) {
                            found.push({ left: left.id, right: right.id, duty: leftDuty.id, other: rightDuty.id, assignee: left.assignee });
                        }
                    }
                }
            }
        }
        return found;
    }

    assertNoConflicts(): void {
        const found: DutyConflictRecord[] = this.conflicts();
        if (found.length > 0) {
            fail(
                "duty_conflict",
                found.map((record: DutyConflictRecord): string => `${record.assignee}: ${record.duty} conflicts with ${record.other}`),
            );
        }
    }

    /**
     * A duty has one accountable owner. An accepted assignment already reserves
     * the duty, so a second one is rejected before activation.
     */
    private assertSingleAccountable(candidate: ResponsibilityAssignment): void {
        const candidateDuties: Set<Id> = new Set<Id>(candidate.duties.map((duty: Duty): Id => duty.id));
        for (const existing of this.assignments.values()) {
            if (existing.id === candidate.id) {
                continue;
            }
            if (existing.status !== "active" && existing.status !== "accepted") {
                continue;
            }
            for (const duty of existing.duties) {
                if (candidateDuties.has(duty.id)) {
                    fail("multiple_accountable", [`duty ${duty.id} is already held by ${existing.id}`]);
                }
            }
        }
    }

    private assertNoDutyConflict(candidate: ResponsibilityAssignment): void {
        for (const existing of this.assignments.values()) {
            if (existing.id === candidate.id) {
                continue;
            }
            if (existing.assignee !== candidate.assignee) {
                continue;
            }
            if (existing.status !== "active" && existing.status !== "accepted") {
                continue;
            }
            if (!windowsOverlap(candidate.window, existing.window)) {
                continue;
            }
            for (const left of candidate.duties) {
                for (const right of existing.duties) {
                    if (dutyConflict(left, right)) {
                        fail("duty_conflict", [`${left.id} conflicts with ${right.id} for ${candidate.assignee}`]);
                    }
                }
            }
        }
    }

    private require(id: Id): ResponsibilityAssignment {
        const assignment: ResponsibilityAssignment | undefined = this.assignments.get(id);
        if (assignment === (void 0)) {
            throw new AssignmentError("assignment_invalid", [`unknown assignment ${id}`]);
        }
        return assignment;
    }

    private requireStatus(assignment: ResponsibilityAssignment, allowed: readonly AssignmentStatus[], action: string): void {
        if (!allowed.includes(assignment.status)) {
            fail("status_transition", [`${assignment.id} is ${assignment.status}; cannot ${action}`]);
        }
    }

    private record(type: AssignmentEvent["type"], assignment: ResponsibilityAssignment, by: Id, at: Timestamp, reason?: string): void {
        this.eventLog.push({
            type,
            assignment: assignment.id,
            at,
            by,
            ...(reason === (void 0) ? {} : { reason }),
            ...(assignment.digest === (void 0) ? {} : { digest: assignment.digest }),
        });
    }
}
