/**
 * Kernel errors: illegal process/thread transitions and exhausted resources.
 *
 * They share the `AmpError` shape (`code` + every problem found) so a caller can
 * turn any of them into a blocked receipt without special-casing.
 */
import { AmpError } from "./ampError.ts";

export type KernelCode =
    | "invalid_process"
    | "invalid_thread"
    | "invalid_transition"
    | "unknown_process"
    | "unknown_thread"
    | "budget_exceeded"
    | "missing_receipt"
    | "agent_busy"
    | "claim_failed"
    | "lease_lost"
    | "unknown_object"
    | "duplicate_task";

export class KernelError extends AmpError<KernelCode> {
    constructor(code: KernelCode, problems: readonly string[]) {
        super("KernelError", code, problems);
    }
}
