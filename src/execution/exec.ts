import type { Budget, Handle, Usage } from "../types/common.ts";
import type { Claim } from "../warrant/epistemic.ts";
import type { Receipt } from "../receipt/receipt.ts";
import { digestOf } from "../semantic/canonical.ts";
import { BudgetExceeded, Dispatcher } from "../attention/budget.ts";
import { HandleStore } from "./handles.ts";
import { PolicyEngine } from "../policy/policy.ts";
import type { Approval, EffectClass, PolicyVerdict } from "../policy/policy.ts";
import { digestTool, pinTools, verifyToolPins } from "./pin.ts";
import type { PinVerdict, ToolPins } from "./pin.ts";
import type { Guard } from "../policy/guard.ts";
import type { McpClient } from "../module/mcp/client.ts";
import type { CallToolResult, ListToolsResult, McpTool } from "../module/mcp/protocol.ts";
import { textOf } from "../module/mcp/protocol.ts";
import { BoundaryRejection, parseToolCall } from "../boundary/index.ts";
import type { ParsedToolCall } from "../boundary/index.ts";

export class DriftDetected extends Error {
    readonly code = "security_event";
    readonly receipt?: Receipt;

    constructor(message: string, receipt?: Receipt) {
        super(message);
        this.name = "DriftDetected";
        this.receipt = receipt;
    }
}

export class ApprovalRequired extends Error {
    readonly code = "approval_required";
    readonly receipt?: Receipt;
    readonly reason: string;

    constructor(tool: string, receipt?: Receipt, reason = "action requires explicit host approval") {
        super(`tool ${tool} is not read-only and requires explicit approval: ${reason}`);
        this.name = "ApprovalRequired";
        this.receipt = receipt;
        this.reason = reason;
    }
}

export class PolicyDenied extends Error {
    readonly code = "denied";
    readonly receipt?: Receipt;

    constructor(message: string, receipt?: Receipt) {
        super(message);
        this.name = "PolicyDenied";
        this.receipt = receipt;
    }
}

export interface ExecOptions {
    budget: Budget;
    handles: HandleStore;
    now: () => string;
    /**
     * Anything above this becomes a handle. Never truncate.
     */
    maxResultTokens?: number;
    /**
     * If true, non-read-only tools need approval.
     */
    requireApproval?: boolean;
    onReceipt?: (receipt: Receipt) => void;
    /**
     * Host policy engine. When omitted, a default engine is created: reads need
     * no warrant, every other effect needs a held claim at the normative tier,
     * and high-risk effects need a host approval.
     */
    policy?: PolicyEngine;
    /**
     * Optional rate/breaker/cost guard, applied before dispatch.
     */
    guard?: Guard;
    /**
     * Re-list the catalog and compare per-tool digests immediately before each
     * call. Defaults to true so a change inside the TTL window fails closed.
     */
    verifyPinsAtCall?: boolean;
    /**
     * Validate arguments against the tool's `inputSchema` before policy and
     * dispatch. Defaults to true: an argument set the schema rejects never
     * reaches a server, and the rejection is recorded as a blocked receipt.
     */
    validateArgs?: boolean;
}

export interface CatalogSnapshot {
    tools: McpTool[];
    /**
     * Order-independent digest of the pinned tool set.
     */
    digest: string;
    /**
     * Per-tool pins used for call-time checks.
     */
    pins: ToolPins;
    ttlMs: number;
    expiresAt: number;
}

export interface CallOptions {
    /**
     * Host-issued approval bound to action/tool/args; never a model boolean.
     */
    approval?: Approval | string;
    /**
     * Warrant for the action. Required for every non-read effect.
     */
    claim?: Claim;
    /**
     * Override the effect class inferred from the tool annotations.
     */
    effect?: EffectClass;
    /**
     * Optional money charge checked against the guard's ceiling.
     */
    money?: number;
    /**
     * @deprecated Ignored; use `approval`. Kept for source compatibility.
     */
    approved?: boolean;
    budgetTokens?: number;
    predictedVoi?: number;
    realizedVoi?: number;
}

export interface CallOutcome {
    receipt: Receipt;
    inline?: string;
    handle?: string;
    tokens: number;
}

/**
 * Map MCP annotations onto the policy taxonomy.
 */
const effectFor: (tool: McpTool) => EffectClass = (tool: McpTool): EffectClass => {
    if (tool.annotations?.readOnlyHint === true) {
        return "read";
    }
    if (tool.annotations?.destructiveHint === true) {
        return "deploy";
    }
    return "write-irreversible";
};

/**
 * Exec profile: MCP tools behind the same budget, shaping, and receipt rules
 * as any other action. Digest pinning makes a post-approval metadata change a
 * security event rather than a surprise (Deadbugz / MCPoison).
 */
export class ExecProfile {
    readonly client: McpClient;
    readonly dispatcher: Dispatcher;
    /**
     * Host policy engine; `approveTool`/`policy.approve` are host-only APIs.
     */
    readonly policy: PolicyEngine;

    private readonly handles: HandleStore;
    private readonly now: () => string;
    private readonly maxResultTokens: number;
    private readonly onReceipt?: (receipt: Receipt) => void;
    private readonly guard?: Guard;
    private readonly verifyPinsAtCall: boolean;
    private readonly validateArgs: boolean;

    private catalog?: CatalogSnapshot;
    private seq = 0;

    constructor(client: McpClient, options: ExecOptions) {
        this.client = client;
        this.handles = options.handles;
        this.now = options.now;
        this.maxResultTokens = options.maxResultTokens ?? 1200;
        this.onReceipt = options.onReceipt;
        this.guard = options.guard;
        this.verifyPinsAtCall = options.verifyPinsAtCall ?? true;
        this.validateArgs = options.validateArgs ?? true;
        this.policy =
            options.policy ??
            new PolicyEngine({
                now: options.now,
                approvalEffects: options.requireApproval === false ? new Set<EffectClass>() : undefined,
            });
        this.dispatcher = new Dispatcher(options.budget);
    }

    async connect(): Promise<CatalogSnapshot> {
        await this.client.negotiate();
        const list: ListToolsResult = await this.client.listTools();
        const pins: ToolPins = pinTools(list.tools);
        const snapshot: CatalogSnapshot = {
            tools: list.tools,
            digest: pins.catalog,
            pins,
            ttlMs: list.ttlMs,
            expiresAt: Date.now() + list.ttlMs,
        };
        this.catalog = snapshot;
        return snapshot;
    }

    /**
     * Re-list and compare. Any changed, added or removed tool fails closed.
     */
    async refresh(): Promise<CatalogSnapshot> {
        const list: ListToolsResult = await this.client.listTools();
        const pins: ToolPins = pinTools(list.tools);
        if (this.catalog) {
            const verdict: PinVerdict = verifyToolPins(this.catalog.pins, list.tools);
            if (!verdict.ok) {
                throw new DriftDetected(
                    `tool catalog changed: ${verdict.reasons.join("; ")}`,
                    this.receipt("catalog.refresh", this.dispatcher.usage(), "blocked", {
                        note: verdict.reasons.join("; "),
                    }),
                );
            }
        }
        const snapshot: CatalogSnapshot = {
            tools: list.tools,
            digest: pins.catalog,
            pins,
            ttlMs: list.ttlMs,
            expiresAt: Date.now() + list.ttlMs,
        };
        this.catalog = snapshot;
        return snapshot;
    }

    async ensureFresh(): Promise<void> {
        if (!this.catalog) {
            await this.connect();
            return;
        }
        if (Date.now() < this.catalog.expiresAt) {
            return;
        }
        await this.refresh();
    }

    tools(): McpTool[] {
        return this.catalog?.tools ?? [];
    }

    tool(name: string): McpTool | undefined {
        return this.tools().find((tool) => tool.name === name);
    }

    /**
     * Host-only convenience: issue an approval bound to the current tool schema
     * and the exact arguments. The model must never be given this method.
     */
    approveTool(name: string, args: Record<string, unknown>, approvedBy: string, ttlMs?: number, scope?: string[]): Approval {
        const tool: McpTool | undefined = this.tool(name);
        if (!tool) {
            throw new PolicyDenied(`unknown tool: ${name}`);
        }
        return this.policy.approve({
            action: name,
            effect: effectFor(tool),
            approvedBy,
            ttlMs,
            scope,
            toolDigest: digestTool(tool),
            argsDigest: digestOf(args),
        });
    }

    /**
     * Non-throwing drift check for monitoring.
     */
    async verify(): Promise<{
        ok: boolean;
        digest: string;
    }> {
        const list: ListToolsResult = await this.client.listTools();
        const pins: ToolPins = pinTools(list.tools);
        return {
            ok: this.catalog !== (void 0) && pins.catalog === this.catalog.digest,
            digest: pins.catalog,
        };
    }

    async call(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallOutcome> {
        await this.ensureFresh();
        const tool: McpTool | undefined = this.tool(name);
        if (!tool) {
            throw new PolicyDenied(`unknown tool: ${name}`, this.receipt(name, this.dispatcher.usage(), "blocked", { note: `unknown_tool:${name}` }));
        }

        if (this.verifyPinsAtCall) {
            const fresh: ListToolsResult = await this.client.listTools();
            const pinned: PinVerdict = verifyToolPins(this.catalog?.pins ?? pinTools([]), fresh.tools);
            if (!pinned.ok) {
                const receipt: Receipt = this.receipt(name, this.dispatcher.usage(), "blocked", {
                    note: pinned.reasons.join("; "),
                });
                throw new DriftDetected(`tool changed before call: ${pinned.reasons.join("; ")}`, receipt);
            }
        }

        let callArgs: Record<string, unknown> = args;
        let argsDigest: string = digestOf(args);
        if (this.validateArgs) {
            try {
                const parsed: ParsedToolCall = parseToolCall({ name: tool.name, inputSchema: tool.inputSchema }, args);
                callArgs = parsed.args;
                argsDigest = parsed.digest;
            } catch (error) {
                if (error instanceof BoundaryRejection) {
                    const receipt: Receipt = this.receipt(name, this.dispatcher.usage(), "blocked", {
                        note: `invalid_tool_args:${error.problems.join("; ")}`,
                    });
                    throw new PolicyDenied(`invalid arguments for ${name}: ${error.problems.join("; ")}`, receipt);
                }
                throw error;
            }
        }

        const effect: EffectClass = options.effect ?? effectFor(tool);
        const verdict: PolicyVerdict = this.policy.decide(
            {
                action: name,
                target: { kind: "tool", id: `mcp.${name}` },
                effect,
                claim: options.claim,
                toolDigest: digestTool(tool),
                argsDigest,
            },
            options.approval,
        );
        if (verdict.outcome !== "allow") {
            const receipt: Receipt = this.receipt(name, this.dispatcher.usage(), "blocked", {
                note: `${verdict.outcome}:${verdict.reason}`,
            });
            if (verdict.outcome === "approval_required") {
                throw new ApprovalRequired(name, receipt, verdict.reason);
            }
            throw new PolicyDenied(`policy denied ${name}: ${verdict.reason}`, receipt);
        }

        try {
            this.guard?.beforeDispatch({ money: options.money ?? 0 });
        } catch (error) {
            const receipt: Receipt = this.receipt(name, this.dispatcher.usage(), "blocked", {
                note: error instanceof Error ? error.message : `${error}`,
            });
            throw new PolicyDenied(`guard blocked ${name}: ${`${error}`}`, receipt);
        }

        const budgetTokens: number = options.budgetTokens ?? this.maxResultTokens;

        let text: string;
        try {
            const result: CallToolResult = await this.dispatcher.run(() => this.client.callTool(name, callArgs), {
                calls: 1,
                ms: 900,
            });
            text = textOf(result);
            this.guard?.recordSuccess();
        } catch (error) {
            this.guard?.recordFailure();
            this.receipt(name, this.dispatcher.usage(), "blocked", {
                note: error instanceof BudgetExceeded ? `${error.code}:${error.dimension}` : `${error}`,
            });
            throw error;
        }

        const tokens: number = Math.ceil(text.length / 4);
        if (tokens > budgetTokens) {
            const handle: Handle = this.handles.put(text, "text", tokens);
            const receipt: Receipt = this.receipt(name, this.dispatcher.usage(), "success", {
                handle,
                predicted_voi: options.predictedVoi,
                realized_voi: options.realizedVoi,
                note: `result ${tokens} tokens > budget ${budgetTokens}; handle emitted, nothing truncated`,
            });
            return { receipt, handle: handle.id, tokens };
        }

        const receipt: Receipt = this.receipt(name, this.dispatcher.usage(), "success", {
            predicted_voi: options.predictedVoi,
            realized_voi: options.realizedVoi,
        });
        return { receipt, inline: text, tokens };
    }

    private receipt(tool: string, usage: Usage, outcome: Receipt["outcome"], extra: Partial<Receipt> = {}): Receipt {
        this.seq += 1;
        const receipt: Receipt = {
            amp: "0.1",
            kind: "receipt",
            id: `rc.exec.${this.seq}`,
            op: "act",
            target: { kind: "tool", id: `mcp.${tool}` },
            at: this.now(),
            usage,
            outcome,
            ...extra,
        };
        this.onReceipt?.(receipt);
        return receipt;
    }
}
