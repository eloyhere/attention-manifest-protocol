/**
 * Tool permission policy. The runtime asks before executing a tool; MCP
 * annotations can supply the risk tier.
 */
import type { ToolDescriptor, ToolInvocation, ToolRisk } from "./tool.ts";

export interface ToolDecision {
    allowed: boolean;
    reason?: string;
}

export interface ToolPolicy {
    check(invocation: ToolInvocation, descriptor: ToolDescriptor): Promise<ToolDecision>;
}

export interface RiskToolPolicyOptions {
    /** If set, only these tools are allowed. */
    allowedTools?: readonly string[];
    /** Risk tiers that need explicit approval. Defaults to destructive only. */
    requireApproval?: readonly ToolRisk[];
    approve?: (invocation: ToolInvocation, descriptor: ToolDescriptor) => boolean | Promise<boolean>;
}

export class RiskToolPolicy implements ToolPolicy {
    private readonly allowed: Set<string> | undefined;
    private readonly approval: Set<ToolRisk>;
    private readonly approve?: RiskToolPolicyOptions["approve"];

    constructor(options: RiskToolPolicyOptions = {}) {
        this.allowed = options.allowedTools === undefined ? undefined : new Set(options.allowedTools);
        this.approval = new Set(options.requireApproval ?? ["destructive"]);
        this.approve = options.approve;
    }

    async check(invocation: ToolInvocation, descriptor: ToolDescriptor): Promise<ToolDecision> {
        if (this.allowed !== undefined && !this.allowed.has(descriptor.name)) {
            return { allowed: false, reason: `tool ${descriptor.name} is not in the allowlist` };
        }
        if (!this.approval.has(descriptor.risk ?? "read")) return { allowed: true };
        if (this.approve === undefined) return { allowed: false, reason: `tool ${descriptor.name} requires approval` };
        const approved = await this.approve(invocation, descriptor);
        return approved ? { allowed: true } : { allowed: false, reason: `tool ${descriptor.name} was not approved` };
    }
}
