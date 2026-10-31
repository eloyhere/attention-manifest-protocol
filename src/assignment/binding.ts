/**
 * Interaction binding ledger.
 *
 * A binding is the conversation contract between parties: who may talk to whom,
 * under which protocol and mode mix, at what cadence, with what budget, and
 * where a timeout or authority breach escalates. Messages are legal only while
 * their binding is active.
 */
import type { Budget, Id, Ref, Signature, Timestamp } from "../types/common.ts";
import { digestOf } from "../semantic/canonical.ts";
import { InteractionKinds } from "../interaction/interaction.ts";
import type { InteractionKind } from "../interaction/interaction.ts";
import type {
    BindingDirection,
    BindingEvent,
    BindingMessageRecord,
    BindingStatus,
    ChannelKind,
    EscalationWhen,
    InteractionBinding,
    InteractionCadence,
    InteractionChannel,
    InteractionEscalation,
    InteractionExpectations,
    InteractionHandoff,
    InteractionProtocol,
    Performative,
    ProtocolRole,
    ResponsibilityAssignment,
} from "./types.ts";
import type { BindingCode } from "./errors.ts";
import { BindingError } from "./errors.ts";
import { budgetWithin, BudgetDimensions } from "./guards.ts";

export interface BindingLedgerOptions {
    now: () => Timestamp;
}

export interface BindingPolicy {
    /**
     * Required when the binding cites an assignment: the ledger never trusts a
     * peer-supplied budget or assignee.
     */
    assignment?: ResponsibilityAssignment;
    /**
     * Principals outside `parties` that may receive an escalation, for example
     * a human owner. Self-escalation to the initiator is always rejected.
     */
    allowedEscalationTargets?: Id[];
}

export interface CreateBindingInput {
    id: Id;
    assignment?: Id;
    parties: Id[];
    purpose: Ref;
    channel: InteractionChannel;
    protocol: InteractionProtocol;
    mode_mix: Partial<Record<InteractionKind, number>>;
    direction: BindingDirection;
    cadence: InteractionCadence;
    expectations?: InteractionExpectations;
    escalation?: InteractionEscalation[];
    handoff?: InteractionHandoff;
    budget?: Budget;
    why: string;
    created?: Timestamp;
    signatures?: Signature[];
}

export interface BindingMessageInput {
    binding: Id;
    from: Id;
    to: Id;
    performative: Performative;
    at: Timestamp;
    usage?: Budget;
}

export interface BindingMessageResult {
    binding: InteractionBinding;
    message: BindingMessageRecord;
    messages: number;
    turns: number;
}

export interface BindingSweep {
    binding: InteractionBinding;
    action: "escalate" | "breach";
    to?: Id;
}

const Performatives: readonly Performative[] = ["inform", "request", "propose", "commit", "decline", "cancel", "release"];

const ChannelKinds: readonly ChannelKind[] = ["local", "a2a", "mcp", "http", "human"];

const ProtocolRoles: readonly ProtocolRole[] = ["initiator", "responder", "observer"];

const EscalationWhens: readonly EscalationWhen[] = ["timeout", "authority_exceeded", "conflict", "budget_exhausted", "integrity_failure", "manual"];

const Directions: readonly BindingDirection[] = ["one-way", "request-response", "duplex", "broadcast"];

const fail: (code: BindingCode, problems: readonly string[]) => never = (code: BindingCode, problems: readonly string[]): never => {
    throw new BindingError(code, problems);
};

const clone: <T>(value: T) => T = <T>(value: T): T => structuredClone(value);

const seal: (binding: InteractionBinding) => InteractionBinding = (binding: InteractionBinding): InteractionBinding => {
    const body: Record<string, unknown> = { ...binding };
    delete body.digest;
    delete body.signatures;
    binding.digest = digestOf(body);
    return binding;
};

const initiatorOf: (binding: InteractionBinding) => Id = (binding: InteractionBinding): Id => {
    const entry = binding.protocol.roles.find((role) => role.role === "initiator");
    return entry === (void 0) ? binding.parties[0] : entry.party;
};

const validateParties: (parties: readonly Id[]) => void = (parties: readonly Id[]): void => {
    if (parties.length < 2) {
        fail("binding_invalid", ["a binding needs at least two parties"]);
    }
    const seen: Set<Id> = new Set<Id>();
    for (let index: number = 0; index < parties.length; index += 1) {
        const party: Id = parties[index];
        if (party.length === 0) {
            fail("binding_invalid", ["a party id must not be empty"]);
        }
        if (seen.has(party)) {
            fail("binding_invalid", [`duplicate party ${party}`]);
        }
        seen.add(party);
    }
};

const validateProtocol: (parties: readonly Id[], protocol: InteractionProtocol, direction: BindingDirection) => void = (
    parties: readonly Id[],
    protocol: InteractionProtocol,
    direction: BindingDirection,
): void => {
    if (protocol.id.length === 0 || protocol.version.length === 0) {
        fail("binding_invalid", ["protocol id and version must not be empty"]);
    }
    if (protocol.roles.length !== parties.length) {
        fail("protocol_role_missing", ["protocol roles must cover every party exactly once"]);
    }
    const seen: Set<Id> = new Set<Id>();
    let initiators: number = 0;
    let responders: number = 0;
    for (let index: number = 0; index < protocol.roles.length; index += 1) {
        const entry = protocol.roles[index];
        if (!ProtocolRoles.includes(entry.role)) {
            fail("protocol_role_missing", [`unknown protocol role ${entry.role}`]);
        }
        if (!parties.includes(entry.party)) {
            fail("protocol_role_missing", [`${entry.party} is not a party`]);
        }
        if (seen.has(entry.party)) {
            fail("protocol_role_missing", [`${entry.party} has more than one role`]);
        }
        seen.add(entry.party);
        if (entry.role === "initiator") {
            initiators += 1;
        }
        if (entry.role === "responder") {
            responders += 1;
        }
    }
    if (initiators !== 1) {
        fail("protocol_role_missing", ["a binding needs exactly one initiator"]);
    }
    if (responders === 0 && (direction === "request-response" || direction === "duplex")) {
        fail("protocol_role_missing", [`a ${direction} binding needs at least one responder`]);
    }
    for (let index: number = 0; index < parties.length; index += 1) {
        if (!seen.has(parties[index])) {
            fail("protocol_role_missing", [`${parties[index]} has no protocol role`]);
        }
    }
};

const cleanModeMix: (input: Partial<Record<InteractionKind, number>>) => Partial<Record<InteractionKind, number>> = (
    input: Partial<Record<InteractionKind, number>>,
): Partial<Record<InteractionKind, number>> => {
    const keys: string[] = Object.keys(input);
    for (let index: number = 0; index < keys.length; index += 1) {
        if (!InteractionKinds.includes(keys[index] as InteractionKind)) {
            fail("mode_mix_invalid", [`unknown interaction mode ${keys[index]}`]);
        }
    }
    const clean: Partial<Record<InteractionKind, number>> = {};
    let positive: number = 0;
    for (let index: number = 0; index < InteractionKinds.length; index += 1) {
        const kind: InteractionKind = InteractionKinds[index];
        const value: number | undefined = input[kind];
        if (value === (void 0)) {
            continue;
        }
        if (!Number.isFinite(value) || value < 0 || value > 1) {
            fail("mode_mix_invalid", [`mode ${kind} must be in [0, 1]`]);
        }
        clean[kind] = value;
        if (value > 0) {
            positive += 1;
        }
    }
    if (positive === 0) {
        fail("mode_mix_invalid", ["mode_mix needs at least one positive weight"]);
    }
    return clean;
};

const validateChannel: (channel: InteractionChannel) => void = (channel: InteractionChannel): void => {
    if (!ChannelKinds.includes(channel.kind)) {
        fail("binding_invalid", [`unknown channel ${channel.kind}`]);
    }
    if (channel.kind === "a2a" && (channel.endpoint === (void 0) || channel.endpoint.length === 0)) {
        fail("channel_unreachable", ["an a2a binding needs an endpoint"]);
    }
    if (channel.auth !== (void 0) && !["none", "ed25519", "oauth", "mtls"].includes(channel.auth)) {
        fail("binding_invalid", [`unknown channel auth ${channel.auth}`]);
    }
};

const validateCadence: (cadence: InteractionCadence) => void = (cadence: InteractionCadence): void => {
    if (!Number.isInteger(cadence.max_turns) || cadence.max_turns < 1) {
        fail("cadence_invalid", ["max_turns must be a positive integer"]);
    }
    if (!Number.isInteger(cadence.max_messages) || cadence.max_messages < 1) {
        fail("cadence_invalid", ["max_messages must be a positive integer"]);
    }
    if (!Number.isInteger(cadence.response_within_ms) || cadence.response_within_ms < 1) {
        fail("cadence_invalid", ["response_within_ms must be a positive integer"]);
    }
    if (cadence.interval_ms !== (void 0) && (!Number.isInteger(cadence.interval_ms) || cadence.interval_ms < 0)) {
        fail("cadence_invalid", ["interval_ms must be a non-negative integer"]);
    }
};

const validateEscalation: (parties: readonly Id[], initiator: Id, rules: readonly InteractionEscalation[], allowed: readonly Id[]) => void = (
    parties: readonly Id[],
    initiator: Id,
    rules: readonly InteractionEscalation[],
    allowed: readonly Id[],
): void => {
    for (let index: number = 0; index < rules.length; index += 1) {
        const rule: InteractionEscalation = rules[index];
        if (!EscalationWhens.includes(rule.when)) {
            fail("binding_invalid", [`unknown escalation trigger ${rule.when}`]);
        }
        if (!Number.isInteger(rule.within_ms) || rule.within_ms < 0) {
            fail("binding_invalid", ["escalation within_ms must be a non-negative integer"]);
        }
        if (rule.to === initiator) {
            fail("escalation_unauthorized", ["a binding cannot escalate to its own initiator"]);
        }
        if (!parties.includes(rule.to) && !allowed.includes(rule.to)) {
            fail("escalation_unauthorized", [`${rule.to} is not a party or an allowed target`]);
        }
    }
};

const validateHandoff: (handoff: InteractionHandoff) => void = (handoff: InteractionHandoff): void => {
    if (handoff.required_state.length === 0) {
        fail("handoff_state_missing", ["a handoff needs at least one required state ref"]);
    }
    if (handoff.acceptance !== "ack" && handoff.acceptance !== "receipt") {
        fail("binding_invalid", ["handoff acceptance must be ack or receipt"]);
    }
};

const validateBudget: (budget: Budget) => void = (budget: Budget): void => {
    for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
        const dimension: keyof Budget = BudgetDimensions[index];
        const value: number | undefined = budget[dimension];
        if (value !== (void 0) && (!Number.isFinite(value) || value < 0)) {
            fail("binding_invalid", [`budget ${dimension} must be a finite non-negative number`]);
        }
    }
};

const cleanChannel: (channel: InteractionChannel) => InteractionChannel = (channel: InteractionChannel): InteractionChannel => ({
    kind: channel.kind,
    ...(channel.endpoint === (void 0) ? {} : { endpoint: channel.endpoint }),
    ...(channel.auth === (void 0) ? {} : { auth: channel.auth }),
});

const cleanCadence: (cadence: InteractionCadence) => InteractionCadence = (cadence: InteractionCadence): InteractionCadence => ({
    max_turns: cadence.max_turns,
    max_messages: cadence.max_messages,
    response_within_ms: cadence.response_within_ms,
    ...(cadence.interval_ms === (void 0) ? {} : { interval_ms: cadence.interval_ms }),
});

const cleanExpectations: (expectations: InteractionExpectations) => InteractionExpectations = (
    expectations: InteractionExpectations,
): InteractionExpectations => ({
    ...(expectations.format === (void 0) ? {} : { format: expectations.format }),
    ...(expectations.language === (void 0) ? {} : { language: expectations.language }),
    ...(expectations.evidence_tier === (void 0) ? {} : { evidence_tier: expectations.evidence_tier }),
});

const cleanEscalation: (rules: readonly InteractionEscalation[]) => InteractionEscalation[] = (
    rules: readonly InteractionEscalation[],
): InteractionEscalation[] =>
    rules.map(
        (rule: InteractionEscalation): InteractionEscalation => ({
            when: rule.when,
            to: rule.to,
            within_ms: rule.within_ms,
            ...(rule.fallback === (void 0) ? {} : { fallback: rule.fallback }),
        }),
    );

const addUsage: (current: Budget, delta: Budget) => Budget = (current: Budget, delta: Budget): Budget => {
    const next: Budget = { ...current };
    for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
        const dimension: keyof Budget = BudgetDimensions[index];
        const value: number | undefined = delta[dimension];
        if (value === (void 0)) {
            continue;
        }
        if (!Number.isFinite(value) || value < 0) {
            fail("binding_invalid", [`usage ${dimension} must be a finite non-negative number`]);
        }
        next[dimension] = (next[dimension] ?? 0) + value;
    }
    return next;
};

export class BindingLedger {
    private readonly bindings: Map<Id, InteractionBinding> = new Map<Id, InteractionBinding>();
    private readonly eventLog: BindingEvent[] = [];
    private readonly acknowledgements: Map<Id, Map<Id, Timestamp>> = new Map<Id, Map<Id, Timestamp>>();
    private readonly messages: Map<Id, BindingMessageRecord[]> = new Map<Id, BindingMessageRecord[]>();
    private readonly usage: Map<Id, Budget> = new Map<Id, Budget>();
    private readonly lastActivity: Map<Id, Timestamp> = new Map<Id, Timestamp>();
    private readonly now: () => Timestamp;

    constructor(options: BindingLedgerOptions) {
        if (typeof(options.now) !== "function") {
            throw new TypeError("BindingLedger requires a clock");
        }
        this.now = options.now;
    }

    create(input: CreateBindingInput, policy: BindingPolicy = {}): InteractionBinding {
        if (input.id.length === 0) {
            fail("binding_invalid", ["a binding id must not be empty"]);
        }
        if (this.bindings.has(input.id)) {
            fail("binding_invalid", [`binding ${input.id} already exists`]);
        }
        if (input.why.trim().length === 0) {
            fail("binding_invalid", ["why must not be empty"]);
        }
        if (input.purpose.id.length === 0) {
            fail("binding_invalid", ["purpose.id must not be empty"]);
        }
        validateParties(input.parties);
        if (!Directions.includes(input.direction)) {
            fail("binding_invalid", [`unknown direction ${input.direction}`]);
        }
        validateProtocol(input.parties, input.protocol, input.direction);
        validateChannel(input.channel);
        validateCadence(input.cadence);
        if (input.budget !== (void 0)) {
            validateBudget(input.budget);
        }
        const initiatorRole = input.protocol.roles.find((entry) => entry.role === "initiator");
        const initiator: Id = initiatorRole === (void 0) ? input.parties[0] : initiatorRole.party;
        if (input.escalation !== (void 0)) {
            validateEscalation(input.parties, initiator, input.escalation, policy.allowedEscalationTargets ?? []);
        }
        if (input.handoff !== (void 0)) {
            validateHandoff(input.handoff);
        }

        if (input.assignment !== (void 0)) {
            const assignment: ResponsibilityAssignment | undefined = policy.assignment;
            if (assignment === (void 0)) {
                throw new BindingError("binding_invalid", ["an assignment policy is required when assignment is cited"]);
            }
            if (assignment.id !== input.assignment) {
                fail("binding_invalid", [`policy assignment ${assignment.id} does not match ${input.assignment}`]);
            }
            if (assignment.status !== "active") {
                fail("binding_invalid", [`assignment ${assignment.id} is ${assignment.status}`]);
            }
            if (!input.parties.includes(assignment.assignee)) {
                fail("binding_invalid", ["parties must include the assignment assignee"]);
            }
            if (input.budget !== (void 0) && !budgetWithin(input.budget, assignment.budget)) {
                fail("binding_budget_widened", ["binding budget exceeds the assignment budget"]);
            }
        }

        const binding: InteractionBinding = {
            amp: "0.1",
            kind: "interaction-binding",
            id: input.id,
            version: 1,
            ...(input.assignment === (void 0) ? {} : { assignment: input.assignment }),
            parties: [...input.parties],
            purpose: { ...input.purpose },
            channel: cleanChannel(input.channel),
            protocol: {
                id: input.protocol.id,
                version: input.protocol.version,
                roles: input.protocol.roles.map((entry) => ({ party: entry.party, role: entry.role })),
            },
            mode_mix: cleanModeMix(input.mode_mix),
            direction: input.direction,
            cadence: cleanCadence(input.cadence),
            ...(input.expectations === (void 0) ? {} : { expectations: cleanExpectations(input.expectations) }),
            ...(input.escalation === (void 0) ? {} : { escalation: cleanEscalation(input.escalation) }),
            ...(input.handoff === (void 0)
                ? {}
                : {
                      handoff: {
                          required_state: input.handoff.required_state.map((ref: Ref) => ({ ...ref })),
                          acceptance: input.handoff.acceptance,
                      },
                  }),
            ...(input.budget === (void 0) ? {} : { budget: { ...input.budget } }),
            status: "proposed",
            why: input.why,
            created: input.created ?? this.now(),
            ...(input.signatures === (void 0) ? {} : { signatures: input.signatures.map((signature) => ({ ...signature })) }),
        };
        this.assertNoDuplicate(binding);
        seal(binding);
        this.bindings.set(binding.id, binding);
        this.acknowledgements.set(binding.id, new Map<Id, Timestamp>());
        this.messages.set(binding.id, []);
        this.usage.set(binding.id, {});
        this.lastActivity.set(binding.id, binding.created);
        this.record("binding.proposed", binding, initiator, binding.created);
        return clone(binding);
    }

    ack(id: Id, party: Id, at: Timestamp): InteractionBinding {
        const binding: InteractionBinding = this.require(id);
        this.requireStatus(binding, ["proposed"], "acknowledge");
        if (!binding.parties.includes(party)) {
            fail("binding_unknown_party", [`${party} is not a party of ${id}`]);
        }
        const acknowledgements: Map<Id, Timestamp> = this.acknowledgements.get(id) ?? new Map<Id, Timestamp>();
        if (!acknowledgements.has(party)) {
            acknowledgements.set(party, at);
            this.acknowledgements.set(id, acknowledgements);
            this.record("binding.acked", binding, party, at);
        }
        return clone(binding);
    }

    activate(id: Id, at: Timestamp): InteractionBinding {
        const binding: InteractionBinding = this.require(id);
        this.requireStatus(binding, ["proposed"], "activate");
        const acknowledgements: Map<Id, Timestamp> = this.acknowledgements.get(id) ?? new Map<Id, Timestamp>();
        const missing: Id[] = binding.parties.filter((party: Id): boolean => !acknowledgements.has(party));
        if (missing.length > 0) {
            fail("binding_not_acked", [`missing acknowledgements: ${missing.join(", ")}`]);
        }
        this.assertNoDuplicate(binding);
        binding.status = "active";
        seal(binding);
        this.lastActivity.set(binding.id, at);
        this.record("binding.activated", binding, initiatorOf(binding), at);
        return clone(binding);
    }

    suspend(id: Id, by: Id, at: Timestamp, reason: string): InteractionBinding {
        const binding: InteractionBinding = this.require(id);
        this.requireStatus(binding, ["active"], "suspend");
        if (!binding.parties.includes(by)) {
            fail("binding_unknown_party", [`${by} is not a party of ${id}`]);
        }
        if (reason.trim().length === 0) {
            fail("binding_invalid", ["a suspend needs a reason"]);
        }
        binding.status = "suspended";
        seal(binding);
        this.record("binding.suspended", binding, by, at, reason);
        return clone(binding);
    }

    resume(id: Id, by: Id, at: Timestamp): InteractionBinding {
        const binding: InteractionBinding = this.require(id);
        this.requireStatus(binding, ["suspended"], "resume");
        if (by !== initiatorOf(binding)) {
            fail("binding_invalid", [`${by} cannot resume ${id}`]);
        }
        binding.status = "active";
        seal(binding);
        this.lastActivity.set(binding.id, at);
        this.record("binding.resumed", binding, by, at);
        return clone(binding);
    }

    recordMessage(input: BindingMessageInput): BindingMessageResult {
        const binding: InteractionBinding = this.require(input.binding);
        this.requireStatus(binding, ["active"], "record a message");
        if (input.from === input.to) {
            fail("message_outside_binding", ["a party cannot message itself"]);
        }
        if (!binding.parties.includes(input.from) || !binding.parties.includes(input.to)) {
            fail("message_outside_binding", [`${input.from} -> ${input.to} is outside ${binding.id}`]);
        }
        if (!Performatives.includes(input.performative)) {
            fail("binding_invalid", [`unknown performative ${input.performative}`]);
        }
        const initiator: Id = initiatorOf(binding);
        if ((binding.direction === "one-way" || binding.direction === "broadcast") && input.from !== initiator) {
            fail("message_outside_binding", [`${binding.direction} bindings only allow the initiator to send`]);
        }
        const records: BindingMessageRecord[] = this.messages.get(input.binding) ?? [];
        if (records.length + 1 > binding.cadence.max_messages) {
            fail("binding_cadence_exceeded", [`${binding.id} exceeds max_messages ${binding.cadence.max_messages}`]);
        }
        const turns: number = records.filter((record: BindingMessageRecord): boolean => record.from === initiator).length;
        if (input.from === initiator && turns + 1 > binding.cadence.max_turns) {
            fail("binding_cadence_exceeded", [`${binding.id} exceeds max_turns ${binding.cadence.max_turns}`]);
        }
        const current: Budget = this.usage.get(input.binding) ?? {};
        const next: Budget = input.usage === (void 0) ? current : addUsage(current, input.usage);
        if (binding.budget !== (void 0) && !budgetWithin(next, binding.budget)) {
            fail("binding_budget_exhausted", [`${binding.id} exceeds its interaction budget`]);
        }
        this.usage.set(input.binding, next);
        const record: BindingMessageRecord = {
            binding: input.binding,
            sequence: records.length + 1,
            from: input.from,
            to: input.to,
            performative: input.performative,
            at: input.at,
        };
        records.push(record);
        this.messages.set(input.binding, records);
        this.lastActivity.set(input.binding, input.at);
        this.record("binding.message", binding, input.from, input.at);
        return {
            binding: clone(binding),
            message: { ...record },
            messages: records.length,
            turns: input.from === initiator ? turns + 1 : turns,
        };
    }

    handoff(id: Id, by: Id, at: Timestamp, state: readonly Ref[], ack: boolean, receipt?: Ref): InteractionBinding {
        const binding: InteractionBinding = this.require(id);
        this.requireStatus(binding, ["active"], "hand off");
        const handoff = binding.handoff;
        if (handoff === (void 0)) {
            throw new BindingError("binding_invalid", [`${id} has no handoff contract`]);
        }
        if (!binding.parties.includes(by)) {
            fail("binding_unknown_party", [`${by} is not a party of ${id}`]);
        }
        const missing: Ref[] = handoff.required_state.filter(
            (required: Ref): boolean => !state.some((provided: Ref): boolean => provided.kind === required.kind && provided.id === required.id),
        );
        if (missing.length > 0) {
            fail("handoff_state_missing", [`missing handoff state: ${missing.map((ref: Ref): string => ref.id).join(", ")}`]);
        }
        if (handoff.acceptance === "ack" && !ack) {
            fail("handoff_not_accepted", ["the receiver has not acknowledged the handoff"]);
        }
        if (handoff.acceptance === "receipt" && receipt === (void 0)) {
            fail("handoff_not_accepted", ["the handoff needs a receipt"]);
        }
        binding.status = "closed";
        seal(binding);
        this.record("binding.handoff", binding, by, at);
        return clone(binding);
    }

    close(id: Id, by: Id, at: Timestamp): InteractionBinding {
        const binding: InteractionBinding = this.require(id);
        this.requireStatus(binding, ["active"], "close");
        if (binding.handoff !== (void 0)) {
            fail("handoff_state_missing", [`${id} must be closed by handoff()`]);
        }
        if (!binding.parties.includes(by)) {
            fail("binding_unknown_party", [`${by} is not a party of ${id}`]);
        }
        binding.status = "closed";
        seal(binding);
        this.record("binding.closed", binding, by, at);
        return clone(binding);
    }

    revoke(id: Id, by: Id, at: Timestamp, reason: string): InteractionBinding {
        const binding: InteractionBinding = this.require(id);
        this.requireStatus(binding, ["proposed", "active", "suspended"], "revoke");
        if (reason.trim().length === 0) {
            fail("binding_invalid", ["a revoke needs a reason"]);
        }
        binding.status = "revoked";
        seal(binding);
        this.record("binding.revoked", binding, by, at, reason);
        return clone(binding);
    }

    /**
     * Revoke every non-terminal binding that cites an assignment. Hosts call
     * this from `AssignmentLedger`'s `onRevoke` callback so the two ledgers
     * agree on cascade semantics without importing each other.
     */
    revokeForAssignment(assignment: Id, by: Id, at: Timestamp, reason: string): InteractionBinding[] {
        if (reason.trim().length === 0) {
            fail("binding_invalid", ["a revoke needs a reason"]);
        }
        const revoked: InteractionBinding[] = [];
        for (const binding of this.bindings.values()) {
            if (binding.assignment !== assignment) {
                continue;
            }
            if (binding.status === "closed" || binding.status === "revoked") {
                continue;
            }
            binding.status = "revoked";
            seal(binding);
            this.record("binding.revoked", binding, by, at, reason);
            revoked.push(clone(binding));
        }
        return revoked;
    }

    /**
     * Detect overdue bindings. A timeout escalation rule defers the breach;
     * without one the binding is marked breached.
     */
    sweep(at: Timestamp): BindingSweep[] {
        const results: BindingSweep[] = [];
        for (const binding of this.bindings.values()) {
            if (binding.status !== "active") {
                continue;
            }
            const last: Timestamp = this.lastActivity.get(binding.id) ?? binding.created;
            const elapsed: number = Date.parse(at) - Date.parse(last);
            if (!Number.isFinite(elapsed) || elapsed <= binding.cadence.response_within_ms) {
                continue;
            }
            const timeout: InteractionEscalation | undefined = (binding.escalation ?? []).find(
                (rule: InteractionEscalation): boolean => rule.when === "timeout",
            );
            if (timeout !== (void 0)) {
                if (elapsed >= timeout.within_ms) {
                    this.record("binding.escalated", binding, "system", at, `timeout to ${timeout.to}`);
                    results.push({ binding: clone(binding), action: "escalate", to: timeout.to });
                }
                continue;
            }
            binding.status = "breached";
            seal(binding);
            this.record("binding.breached", binding, "system", at, `no response within ${binding.cadence.response_within_ms}ms`);
            results.push({ binding: clone(binding), action: "breach" });
        }
        return results;
    }

    get(id: Id): InteractionBinding {
        return clone(this.require(id));
    }

    find(id: Id): InteractionBinding | undefined {
        const binding: InteractionBinding | undefined = this.bindings.get(id);
        return binding === (void 0) ? undefined : clone(binding);
    }

    list(): InteractionBinding[] {
        return [...this.bindings.values()].map((binding: InteractionBinding): InteractionBinding => clone(binding));
    }

    messagesFor(id: Id): BindingMessageRecord[] {
        return (this.messages.get(id) ?? []).map((record: BindingMessageRecord): BindingMessageRecord => ({ ...record }));
    }

    usageFor(id: Id): Budget {
        return { ...(this.usage.get(id) ?? {}) };
    }

    events(): BindingEvent[] {
        return this.eventLog.map((event: BindingEvent): BindingEvent => clone(event));
    }

    private require(id: Id): InteractionBinding {
        const binding: InteractionBinding | undefined = this.bindings.get(id);
        if (binding === (void 0)) {
            throw new BindingError("binding_invalid", [`unknown binding ${id}`]);
        }
        return binding;
    }

    private assertNoDuplicate(candidate: InteractionBinding): void {
        const candidateKey: string = [...candidate.parties].sort().join(",");
        for (const existing of this.bindings.values()) {
            if (existing.id === candidate.id || existing.status !== "active") {
                continue;
            }
            if (existing.purpose.kind !== candidate.purpose.kind || existing.purpose.id !== candidate.purpose.id) {
                continue;
            }
            if ([...existing.parties].sort().join(",") === candidateKey) {
                fail("binding_duplicate", [`an active binding already covers ${candidate.purpose.id}`]);
            }
        }
    }

    private requireStatus(binding: InteractionBinding, allowed: readonly BindingStatus[], action: string): void {
        if (!allowed.includes(binding.status)) {
            fail("status_transition", [`${binding.id} is ${binding.status}; cannot ${action}`]);
        }
    }

    private record(type: BindingEvent["type"], binding: InteractionBinding, by: Id, at: Timestamp, reason?: string): void {
        this.eventLog.push({
            type,
            binding: binding.id,
            at,
            by,
            ...(reason === (void 0) ? {} : { reason }),
            ...(binding.digest === (void 0) ? {} : { digest: binding.digest }),
        });
    }
}
