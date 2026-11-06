import type { Budget, BudgetUsage, ExecutionContext, Identifier, InvocationRecord, JsonValue, ObservationRecord } from "../shared.ts";

export type ToolRisk = "read" | "write" | "delete" | "publish" | "payment" | "external_send" | "privilege";
export type ToolEffect = "read_only" | "side_effect";
export interface ToolDefinition<Schema = JsonValue> {
    readonly toolId: Identifier; readonly version: string; readonly digest: string; readonly summary: string;
    readonly inputSchema: Schema; readonly outputSchema?: Schema; readonly risk: ToolRisk; readonly effect: ToolEffect;
    readonly when?: readonly string[]; readonly notWhen?: readonly string[]; readonly preconditions?: readonly string[]; readonly policyScope: string;
}
export interface Manifest<Schema = JsonValue> {
    readonly manifestId: Identifier; readonly tenantId: Identifier; readonly endpointId: Identifier; readonly endpointIdentity: string;
    readonly serverVersion: string; readonly digest: string; readonly signature?: string; readonly policyScope: string;
    readonly issuedAt: string; readonly expiresAt?: string; readonly tools: readonly ToolDefinition<Schema>[];
}
export interface ToolHandle {
    readonly kind: "tool"; readonly tenantId: Identifier; readonly endpointId: Identifier; readonly toolId: Identifier;
    readonly version: string; readonly digest: string; readonly toolVersion?: string; readonly toolDigest?: string; readonly policyScope: string;
}
export interface DataHandle {
    readonly kind: "data"; readonly id: Identifier; readonly ownerId: Identifier; readonly tenantId: Identifier; readonly sessionId: Identifier;
    readonly sourceReceiptId: Identifier; readonly sourceDigest: string; readonly classification: string; readonly schemaRef: string;
    readonly createdAt: string; readonly expiresAt: string; readonly permissionProjection: readonly string[]; readonly revocationEpoch: number; readonly auditRef: Identifier;
}
export interface TaskHandle {
    readonly kind: "task"; readonly id: Identifier; readonly tenantId: Identifier; readonly endpointId: Identifier; readonly remoteTaskId: string;
    readonly createdAt: string; readonly expiresAt: string; readonly pollAfterMilliseconds: number;
    readonly cancellation: "not_requested" | "cancel_requested" | "unknown"; readonly finalObservationId?: Identifier;
}
export type AuthorizationAction = "find" | "inspect" | "execute" | "read_handle" | "cancel_task";
export interface AuthorizationObject {
    readonly kind: "manifest" | "tool" | "data_handle" | "task_handle"; readonly id: Identifier; readonly tenantId: Identifier;
    readonly ownerId?: Identifier; readonly endpointId?: Identifier; readonly version?: string; readonly digest?: string;
    readonly policyScope?: string; readonly risk?: ToolRisk;
}
export interface AuthorizationRequest { readonly action: AuthorizationAction; readonly context: ExecutionContext; readonly object: AuthorizationObject; readonly input?: JsonValue; }
export interface PolicyDecision { readonly allowed: boolean; readonly policyVersion: string; readonly reason: string; readonly approvalRequired?: boolean; }
export type PolicyDecisionPoint = (request: AuthorizationRequest) => PolicyDecision | Promise<PolicyDecision>;
export interface PolicyEnforcementPoint { authorize(request: AuthorizationRequest): Promise<PolicyDecision>; }
export interface BudgetReservation { readonly id: Identifier; readonly budgetKey: Identifier; readonly amount: Budget; readonly state: "reserved" | "settled" | "released"; readonly actual?: BudgetUsage; }
export interface BudgetSnapshot { readonly limit: Budget; readonly settled: BudgetUsage; readonly reserved: BudgetUsage; }
export interface ChildCall<Input = JsonValue> { readonly id: Identifier; readonly tool: ToolHandle; readonly arguments: Input; readonly budget: Budget; readonly idempotencyKey?: string; }
export interface InvocationObservation { readonly invocation: InvocationRecord; readonly observation: ObservationRecord; }
export interface ChildCallResult<Output = JsonValue> extends InvocationObservation { readonly output?: Output; readonly failure?: string; }
export interface RunResult<Output = JsonValue> { readonly children: readonly ChildCallResult<Output>[]; readonly completed: boolean; }
