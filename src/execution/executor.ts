import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, isObject } from "semantic-typescript";
import type { ExecutionContext, Identifier, InvocationRecord, JsonValue, ObservationRecord } from "../shared.ts";
import type { BudgetLedger } from "../budget/ledger.ts";
import type { ManifestStore } from "../manifest/store.ts";
import type { AuthorizationRequest, ChildCall, ChildCallResult, PolicyEnforcementPoint, RunResult, ToolDefinition } from "../tool/types.ts";
import { PolicyDeniedError } from "../policy/pep.ts";
import { safeStringify } from "../serialization/index.ts";
export { DefaultPolicyEnforcementPoint, PolicyDeniedError } from "../policy/pep.ts";

export class UnknownOutcomeRetryError extends Error {
    readonly operationId: Identifier;
    constructor(operationId: Identifier) {
        super(`Operation ${operationId} has an unknown outcome and requires reconciliation.`);
        this.name = "UnknownOutcomeRetryError";
        this.operationId = operationId;
    }
}

/** Stable machine-readable executor boundary failures; messages never carry stacks. */
export type ExecutorErrorCode = "child_limit_exceeded" | "timeout" | "aborted" | "invalid_options";
export class ExecutorError extends Error {
    readonly code: ExecutorErrorCode;
    constructor(code: ExecutorErrorCode, message: string) {
        super(message);
        this.name = "ExecutorError";
        this.code = code;
    }
}

export const DEFAULT_MAX_CHILD_CALLS = 32;

export type ToolBinding<Input, Output> = (input: Input, definition: ToolDefinition<JsonValue>, context: ExecutionContext) => Promise<Output>;
export interface ExecutorOptions {
    readonly id: () => Identifier;
    readonly now: () => string;
    readonly measure: (input: JsonValue, output?: JsonValue, elapsedMilliseconds?: number) => { tokens?: number; bytes?: number };
    readonly beforeInvoke?: (invocation: InvocationRecord) => void | Promise<void>;
    /** Host checks cancellation epoch, leases and current execution authority. */
    readonly assertActive?: (invocation: InvocationRecord) => void | Promise<void>;
    /** Maximum number of ChildCalls accepted by one run; defaults to 32. */
    readonly maxChildCalls?: number;
    /** Host cancellation propagated into admission and tool invocation. */
    readonly signal?: AbortSignal;
    /** Wall-clock ceiling for one run; the invocation fails with code `timeout`. */
    readonly timeoutMilliseconds?: number;
}

/** Per-run overrides for the boundary settings configured on the executor. */
export interface ExecutorRunOptions {
    readonly maxChildCalls?: number;
    readonly signal?: AbortSignal;
    readonly timeoutMilliseconds?: number;
}

interface Operation<Output> {
    readonly fingerprint: string;
    readonly result: Promise<ChildCallResult<Output>>;
}

function freezeDeep<T>(value: T, seen = new Set<object>()): T {
    if (!isObject(value) || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) { freezeDeep(child, seen); }
    return Object.freeze(value);
}

function safeNonNegativeInteger(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new ExecutorError("invalid_options", `${field} must be a nonnegative safe integer.`);
    }
    return value;
}

function reasonOf(signal: AbortSignal): ExecutorError {
    const reason: unknown = signal.reason;
    return reason instanceof ExecutorError ? reason : new ExecutorError("aborted", "aborted");
}

function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return work;
    if (signal.aborted) return Promise.reject(reasonOf(signal));
    return new Promise<T>((resolve, reject) => {
        let done = false;
        const onAbort = (): void => {
            if (done) return;
            done = true;
            reject(reasonOf(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(
            value => {
                if (done) return;
                done = true;
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            error => {
                if (done) return;
                done = true;
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

interface AbortScope {
    readonly signal?: AbortSignal;
    dispose(): void;
}

function createAbortScope(signal: AbortSignal | undefined, timeoutMilliseconds: number | undefined): AbortScope {
    if (signal === undefined && timeoutMilliseconds === undefined) return { dispose: () => {} };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forwarded: (() => void) | undefined;
    if (timeoutMilliseconds !== undefined) {
        const milliseconds = safeNonNegativeInteger(timeoutMilliseconds, "timeoutMilliseconds");
        timer = setTimeout(() => controller.abort(new ExecutorError("timeout", "timeout")), milliseconds);
    }
    if (signal !== undefined) {
        if (signal.aborted) {
            controller.abort(new ExecutorError("aborted", "aborted"));
        } else {
            forwarded = () => controller.abort(new ExecutorError("aborted", "aborted"));
            signal.addEventListener("abort", forwarded, { once: true });
        }
    }
    return {
        signal: controller.signal,
        dispose: () => {
            if (timer !== undefined) clearTimeout(timer);
            if (forwarded !== undefined) signal?.removeEventListener("abort", forwarded);
        },
    };
}
function stableFingerprint(value: unknown): string {
    return safeStringify(value, { stableKeys: true });
}
/** Stable business operation identity, independent of network attempt/execution IDs. */
export function childOperationKey(context: ExecutionContext, childId: string): string {
    return JSON.stringify([context.tenantId, context.principalId, context.sessionId, context.operationId, childId]);
}

/** In-process coordination only; durable journal and remote deduplication are host responsibilities. */
export class Executor<Input extends JsonValue = JsonValue, Output extends JsonValue = JsonValue> {
    private readonly operations = new SynchronousUnorderedMap<string, Operation<Output>>();
    private readonly unknown = new SynchronousUnorderedSet<string>();
    private readonly manifests: ManifestStore<JsonValue>;
    private readonly policy: PolicyEnforcementPoint;
    private readonly ledger: BudgetLedger;
    private readonly binding: ToolBinding<Input, Output>;
    private readonly options: ExecutorOptions;
    constructor(manifests: ManifestStore<JsonValue>, policy: PolicyEnforcementPoint, ledger: BudgetLedger, binding: ToolBinding<Input, Output>, options: ExecutorOptions) {
        this.manifests = manifests;
        this.policy = policy;
        this.ledger = ledger;
        this.binding = binding;
        this.options = options;
    }
    canRetry(operationId: string): boolean { return !this.unknown.contains(operationId); }
    /** Host-only acknowledgement; the host must separately settle the retained reservation. */
    markReconciled(operationId: string): void {
        if (!this.unknown.contains(operationId)) { throw new Error("Only unknown operations can be reconciled"); }
        this.unknown.remove(operationId);
        this.operations.remove(operationId);
    }
    async run(calls: readonly ChildCall<Input>[], context: ExecutionContext, budgetKey: string, runOptions: ExecutorRunOptions = {}): Promise<RunResult<Output>> {
        const maxChildCalls = safeNonNegativeInteger(
            runOptions.maxChildCalls ?? this.options.maxChildCalls ?? DEFAULT_MAX_CHILD_CALLS,
            "maxChildCalls",
        );
        if (calls.length > maxChildCalls) {
            throw new ExecutorError("child_limit_exceeded", `Child call count ${calls.length} exceeds the limit of ${maxChildCalls}.`);
        }
        const lockedCalls = freezeDeep(structuredClone(calls));
        const lockedContext = freezeDeep(structuredClone(context));
        const ids = new SynchronousUnorderedSet<string>();
        for (const call of lockedCalls) {
            if (!call.id || ids.contains(call.id)) { throw new Error(`Duplicate ChildCall id ${call.id} or empty identity`); }
            ids.add(call.id);
        }
        const scope = createAbortScope(
            runOptions.signal ?? this.options.signal,
            runOptions.timeoutMilliseconds ?? this.options.timeoutMilliseconds,
        );
        try {
            const children: ChildCallResult<Output>[] = [];
            for (const call of lockedCalls) {
                children.push(await this.executeChild(call, lockedContext, budgetKey, scope.signal));
                if (scope.signal?.aborted) break;
            }
            return freezeDeep({ children, completed: children.length > 0 && children.every(child => child.observation.status === "success") });
        } finally {
            scope.dispose();
        }
    }
    private async executeChild(call: ChildCall<Input>, context: ExecutionContext, budgetKey: string, signal?: AbortSignal): Promise<ChildCallResult<Output>> {
        const key = childOperationKey(context, call.id);
        const childContext = { ...context, operationId: key, attemptId: this.options.id() };
        const fingerprint = stableFingerprint({ tenantId: context.tenantId, principalId: context.principalId, sessionId: context.sessionId,
            tool: call.tool, arguments: call.arguments, budget: call.budget, budgetKey, idempotencyKey: call.idempotencyKey });
        const cached = this.operations.get(key);
        if (cached.isPresent()) {
            if (cached.get().fingerprint !== fingerprint) { return this.failed(call, childContext, "Operation key reused with different arguments or scope"); }
            // Recheck read authority before returning even an already completed result.
            try { await abortable(this.admit(call, this.invocation(call, childContext)), signal); }
            catch (error) { return this.failed(call, childContext, error); }
            try { return freezeDeep(structuredClone(await abortable(cached.get().result, signal))); }
            catch (error) { return this.failed(call, childContext, error); }
        }
        if (this.unknown.contains(key)) { return this.failed(call, childContext, new UnknownOutcomeRetryError(key), "unknown"); }
        // An already-cancelled waiter must not start a new shared operation.
        // Once an operation exists, cancellation only rejects that waiter's
        // observation and never interrupts the shared work.
        if (signal?.aborted) { return this.failed(call, childContext, reasonOf(signal)); }
        // Defer work until the operation is registered, so concurrent calls share
        // one execution. A waiter's signal only cancels that wait; it is never
        // passed to the shared operation and therefore cannot kill other waiters.
        const result = Promise.resolve()
            .then(() => this.executeFresh(call, childContext, budgetKey))
            .then(observed => {
                if (observed.observation.status === "failure") this.operations.remove(key);
                return observed;
            }, error => {
                this.operations.remove(key);
                throw error;
            });
        this.operations.put(key, { fingerprint, result });
        try {
            const observed = await abortable(result, signal);
            return freezeDeep(structuredClone(observed));
        } catch (error) {
            const status = error instanceof ExecutorError && (error.code === "timeout" || error.code === "aborted") ? "unknown" : "failure";
            return this.failed(call, childContext, error, status);
        }
    }
    private invocation(call: ChildCall<Input>, context: ExecutionContext): InvocationRecord {
        return freezeDeep(structuredClone({ id: context.attemptId, context, toolId: call.tool.toolId, arguments: call.arguments,
            createdAt: this.options.now(), ...(Optional.ofNullable(call.idempotencyKey).isPresent() ? { idempotencyKey: call.idempotencyKey } : {}) }));
    }
    private async executeFresh(call: ChildCall<Input>, context: ExecutionContext, budgetKey: string, signal?: AbortSignal): Promise<ChildCallResult<Output>> {
        const invocation = this.invocation(call, context);
        let reservation = Optional.empty<string>();
        let invoked = false;
        try {
            this.throwIfAborted(signal);
            await abortable(this.admit(call, invocation), signal);
            const reservationId = this.options.id();
            this.ledger.reserve(reservationId, budgetKey, call.budget);
            reservation = Optional.of(reservationId);
            const journal = Optional.ofNullable(this.options.beforeInvoke);
            if (journal.isPresent()) { await abortable(Promise.resolve(journal.get()(invocation)), signal); }
            const definition = await abortable(this.admit(call, invocation), signal);
            // Final synchronous fence after asynchronous policy/journal calls have returned.
            const latest = this.manifests.findTool(call.tool);
            if (latest.isEmpty() || stableFingerprint(latest.get()) !== stableFingerprint(definition)) { throw new Error("Tool changed before invocation"); }
            this.throwIfAborted(signal);
            const started = performance.now();
            invoked = true;
            const output = await abortable(this.binding(structuredClone(call.arguments), structuredClone(definition), structuredClone(context)), signal);
            // Budget dimensions are safe integers; wall-clock measurement is rounded once here.
            const milliseconds = Math.round(performance.now() - started);
            const measurement = this.options.measure(structuredClone(call.arguments), output, milliseconds);
            this.ledger.settle(reservationId, { ...measurement, milliseconds, calls: 1 });
            return { invocation, observation: { id: this.options.id(), invocationId: invocation.id, status: "success", value: structuredClone(output), observedAt: this.options.now() }, output: structuredClone(output) };
        } catch (error) {
            const boundaryUnknown = error instanceof ExecutorError && (error.code === "timeout" || error.code === "aborted");
            const status = invoked || boundaryUnknown || error instanceof UnknownOutcomeRetryError ? "unknown" : "failure";
            if (status === "unknown") { this.unknown.add(context.operationId); }
            else if (reservation.isPresent()) { this.ledger.release(reservation.get()); }
            return this.failed(call, context, error, status, invocation);
        }
    }
    private throwIfAborted(signal?: AbortSignal): void {
        if (signal?.aborted) throw reasonOf(signal);
    }
    private async admit(call: ChildCall<Input>, invocation: InvocationRecord): Promise<ToolDefinition> {
        if (call.tool.tenantId !== invocation.context.tenantId) { throw new Error("Tool handle tenant mismatch"); }
        const active = Optional.ofNullable(this.options.assertActive);
        if (active.isPresent()) { await active.get()(invocation); }
        const found = this.manifests.findTool(call.tool);
        if (found.isEmpty()) { throw new Error("Tool is stale, revoked, expired or absent"); }
        const definition = found.get();
        const request: AuthorizationRequest = { action: "execute", context: invocation.context, input: invocation.arguments, object: {
            kind: "tool", id: definition.toolId, tenantId: invocation.context.tenantId, endpointId: call.tool.endpointId,
            version: definition.version, digest: definition.digest, policyScope: definition.policyScope, risk: definition.risk,
        } };
        const decision = await this.policy.authorize(structuredClone(request));
        if (!decision.allowed || decision.approvalRequired === true || decision.policyVersion !== invocation.context.policyVersion) { throw new PolicyDeniedError(decision); }
        if (active.isPresent()) { await active.get()(invocation); }
        const current = this.manifests.findTool(call.tool);
        if (current.isEmpty() || stableFingerprint(current.get()) !== stableFingerprint(definition)) { throw new Error("Tool changed during authorization"); }
        return definition;
    }
    private failed(call: ChildCall<Input>, context: ExecutionContext, error: unknown, status: ObservationRecord["status"] = "failure", original?: InvocationRecord): ChildCallResult<Output> {
        const invocation = Optional.ofNullable(original).get(this.invocation(call, context));
        // Never surface stack traces; executor boundary errors expose their stable code instead.
        const message = error instanceof ExecutorError ? error.code : error instanceof Error ? error.message : String(error);
        return freezeDeep({ invocation, observation: { id: this.options.id(), invocationId: invocation.id, status, error: message, observedAt: this.options.now() }, failure: message });
    }
}
export function assertRetrySafe(operationId: string, canRetry: (id: string) => boolean): void {
    if (!canRetry(operationId)) { throw new UnknownOutcomeRetryError(operationId); }
}
