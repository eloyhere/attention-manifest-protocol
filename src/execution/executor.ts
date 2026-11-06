import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, isObject } from "semantic-typescript";
import type { ExecutionContext, Identifier, InvocationRecord, JsonValue, ObservationRecord } from "../shared.ts";
import type { BudgetLedger } from "../budget/ledger.ts";
import type { ManifestStore } from "../manifest/store.ts";
import type { AuthorizationRequest, ChildCall, ChildCallResult, PolicyEnforcementPoint, RunResult, ToolDefinition } from "../tool/types.ts";
import { PolicyDeniedError } from "../policy/pep.ts";
export { DefaultPolicyEnforcementPoint, PolicyDeniedError } from "../policy/pep.ts";

export class UnknownOutcomeRetryError extends Error {
    readonly operationId: Identifier;
    constructor(operationId: Identifier) {
        super(`Operation ${operationId} has an unknown outcome and requires reconciliation.`);
        this.name = "UnknownOutcomeRetryError";
        this.operationId = operationId;
    }
}
export type ToolBinding<Input, Output> = (input: Input, definition: ToolDefinition<JsonValue>, context: ExecutionContext) => Promise<Output>;
export interface ExecutorOptions {
    readonly id: () => Identifier;
    readonly now: () => string;
    readonly measure: (input: JsonValue, output?: JsonValue, elapsedMilliseconds?: number) => { tokens?: number; bytes?: number };
    readonly beforeInvoke?: (invocation: InvocationRecord) => void | Promise<void>;
    /** Host checks cancellation epoch, leases and current execution authority. */
    readonly assertActive?: (invocation: InvocationRecord) => void | Promise<void>;
}
interface Operation<Output> {
    readonly fingerprint: string;
    readonly result: Promise<ChildCallResult<Output>>;
}
function freezeDeep<T>(value: T): T {
    if (isObject(value) && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) { freezeDeep(child); }
        Object.freeze(value);
    }
    return value;
}
function stableJson(value: unknown): string {
    if (Array.isArray(value)) { return `[${value.map(stableJson).join(",")}]`; }
    if (isObject(value)) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(Reflect.get(value, key))}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
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
    async run(calls: readonly ChildCall<Input>[], context: ExecutionContext, budgetKey: string): Promise<RunResult<Output>> {
        const lockedCalls = freezeDeep(structuredClone(calls));
        const lockedContext = freezeDeep(structuredClone(context));
        const ids = new SynchronousUnorderedSet<string>();
        for (const call of lockedCalls) {
            if (!call.id || ids.contains(call.id)) { throw new Error(`Duplicate ChildCall id ${call.id} or empty identity`); }
            ids.add(call.id);
        }
        const children: ChildCallResult<Output>[] = [];
        for (const call of lockedCalls) { children.push(await this.executeChild(call, lockedContext, budgetKey)); }
        return { children, completed: children.length > 0 && children.every(child => child.observation.status === "success") };
    }
    private async executeChild(call: ChildCall<Input>, context: ExecutionContext, budgetKey: string): Promise<ChildCallResult<Output>> {
        const key = childOperationKey(context, call.id);
        const childContext = { ...context, operationId: key, attemptId: this.options.id() };
        const fingerprint = stableJson({ tenantId: context.tenantId, principalId: context.principalId, sessionId: context.sessionId,
            tool: call.tool, arguments: call.arguments, budget: call.budget, budgetKey, idempotencyKey: call.idempotencyKey });
        const cached = this.operations.get(key);
        if (cached.isPresent()) {
            if (cached.get().fingerprint !== fingerprint) { return this.failed(call, childContext, "Operation key reused with different arguments or scope"); }
            // Recheck read authority before returning even an already completed result.
            try { await this.admit(call, this.invocation(call, childContext)); }
            catch (error) { return this.failed(call, childContext, error); }
            return structuredClone(await cached.get().result);
        }
        if (this.unknown.contains(key)) { return this.failed(call, childContext, new UnknownOutcomeRetryError(key), "unknown"); }
        // Defer work until the operation is registered, so concurrent calls share one execution.
        const result = Promise.resolve().then(() => this.executeFresh(call, childContext, budgetKey));
        this.operations.put(key, { fingerprint, result });
        const observed = await result;
        if (observed.observation.status === "failure") { this.operations.remove(key); }
        return structuredClone(observed);
    }
    private invocation(call: ChildCall<Input>, context: ExecutionContext): InvocationRecord {
        return freezeDeep(structuredClone({ id: context.attemptId, context, toolId: call.tool.toolId, arguments: call.arguments,
            createdAt: this.options.now(), ...(Optional.ofNullable(call.idempotencyKey).isPresent() ? { idempotencyKey: call.idempotencyKey } : {}) }));
    }
    private async executeFresh(call: ChildCall<Input>, context: ExecutionContext, budgetKey: string): Promise<ChildCallResult<Output>> {
        const invocation = this.invocation(call, context);
        let reservation = Optional.empty<string>();
        let invoked = false;
        try {
            await this.admit(call, invocation);
            const reservationId = this.options.id();
            this.ledger.reserve(reservationId, budgetKey, call.budget);
            reservation = Optional.of(reservationId);
            const journal = Optional.ofNullable(this.options.beforeInvoke);
            if (journal.isPresent()) { await journal.get()(invocation); }
            const definition = await this.admit(call, invocation);
            // Final synchronous fence after asynchronous policy/journal calls have returned.
            const latest = this.manifests.findTool(call.tool);
            if (latest.isEmpty() || stableJson(latest.get()) !== stableJson(definition)) { throw new Error("Tool changed before invocation"); }
            const started = performance.now();
            invoked = true;
            const output = await this.binding(structuredClone(call.arguments), structuredClone(definition), structuredClone(context));
            const milliseconds = performance.now() - started;
            const measurement = this.options.measure(structuredClone(call.arguments), output, milliseconds);
            this.ledger.settle(reservationId, { ...measurement, milliseconds, calls: 1 });
            return { invocation, observation: { id: this.options.id(), invocationId: invocation.id, status: "success", value: structuredClone(output), observedAt: this.options.now() }, output: structuredClone(output) };
        } catch (error) {
            const status = invoked || error instanceof UnknownOutcomeRetryError ? "unknown" : "failure";
            if (status === "unknown") { this.unknown.add(context.operationId); }
            else if (reservation.isPresent()) { this.ledger.release(reservation.get()); }
            return this.failed(call, context, error, status, invocation);
        }
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
        if (current.isEmpty() || stableJson(current.get()) !== stableJson(definition)) { throw new Error("Tool changed during authorization"); }
        return definition;
    }
    private failed(call: ChildCall<Input>, context: ExecutionContext, error: unknown, status: ObservationRecord["status"] = "failure", original?: InvocationRecord): ChildCallResult<Output> {
        const invocation = Optional.ofNullable(original).get(this.invocation(call, context));
        const message = error instanceof Error ? error.message : String(error);
        return { invocation, observation: { id: this.options.id(), invocationId: invocation.id, status, error: message, observedAt: this.options.now() }, failure: message };
    }
}
export function assertRetrySafe(operationId: string, canRetry: (id: string) => boolean): void {
    if (!canRetry(operationId)) { throw new UnknownOutcomeRetryError(operationId); }
}
