/**
 * Stable rejection codes for responsibility and interaction assignment.
 *
 * Codes are the contract; the human-readable problems are for logs and tests.
 */
import { AmpError } from "../error/ampError.ts";

export type AssignmentCode =
    | "assignment_invalid"
    | "authority_widened"
    | "budget_widened"
    | "window_widened"
    | "depth_exceeded"
    | "parent_unavailable"
    | "multiple_accountable"
    | "accountable_not_party"
    | "acceptance_missing"
    | "acceptance_denied"
    | "duty_conflict"
    | "self_approval"
    | "evidence_missing"
    | "status_transition"
    | "assignment_expired"
    | "window_not_started";

export class AssignmentError extends AmpError<AssignmentCode> {
    constructor(code: AssignmentCode, problems: readonly string[]) {
        super("AssignmentError", code, problems);
    }
}

export type BindingCode =
    | "binding_invalid"
    | "binding_unknown_party"
    | "protocol_role_missing"
    | "channel_unreachable"
    | "mode_mix_invalid"
    | "cadence_invalid"
    | "escalation_unauthorized"
    | "handoff_state_missing"
    | "handoff_not_accepted"
    | "message_outside_binding"
    | "binding_duplicate"
    | "binding_budget_widened"
    | "binding_budget_exhausted"
    | "binding_cadence_exceeded"
    | "binding_not_acked"
    | "status_transition";

export class BindingError extends AmpError<BindingCode> {
    constructor(code: BindingCode, problems: readonly string[]) {
        super("BindingError", code, problems);
    }
}
