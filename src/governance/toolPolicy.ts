/**
 * Pre-execution governance gate for tools.
 *
 * `CognitiveRuntime` already asks a `ToolPolicy` before it calls an executor.
 * This adapter answers that question with the legal gate, the manifest and the
 * evidence floor, so a destructive tool is stopped before the call instead of
 * being audited after it.
 */
import type { ToolDecision, ToolPolicy } from "../module/tool/policy.ts";
import type { ToolDescriptor, ToolInvocation, ToolRisk } from "../module/tool/tool.ts";
import type { EffectClass } from "../policy/policy.ts";
import type { Tier } from "../types/common.ts";
import type { ApprovalGrant } from "./types.ts";
import type { AttentionManifest } from "./attentionManifest.ts";
import type { LegalGate, LegalVerdict, Violation } from "./legal.ts";

export interface GovernedToolPolicyOptions {
    legal: LegalGate;
    manifest: AttentionManifest;
    /**
     * Evidence tier attached to this invocation. When present, the manifest's
     * floor is enforced; omit it when no evidence has been gathered yet.
     */
    evidenceTier?: Tier;
    /**
     * Optional per-tool tier resolver, e.g. read-only tools can claim T2.
     */
    tierFor?: (invocation: ToolInvocation, descriptor: ToolDescriptor) => Tier | undefined;
    /**
     * A pre-issued legal `tool.high-risk` approval. Without it, high-risk tools
     * are denied before the executor sees them.
     */
    approval?: ApprovalGrant;
}

const effectOf: (risk: ToolRisk | undefined) => EffectClass = (risk: ToolRisk | undefined): EffectClass => {
    if (risk === "destructive") {
        return "write-irreversible";
    }
    if (risk === "write") {
        return "write-reversible";
    }
    return "read";
};

export class GovernedToolPolicy implements ToolPolicy {
    private readonly options: GovernedToolPolicyOptions;

    constructor(options: GovernedToolPolicyOptions) {
        this.options = options;
    }

    async check(invocation: ToolInvocation, descriptor: ToolDescriptor): Promise<ToolDecision> {
        if (this.options.legal.isBlocked()) {
            return { allowed: false, reason: "legal breaker is active" };
        }
        if (this.options.legal.isFrozen(this.options.manifest.perspective)) {
            return { allowed: false, reason: `${this.options.manifest.perspective} is frozen` };
        }
        const evidenceTier: Tier | undefined = this.options.tierFor?.(invocation, descriptor) ?? this.options.evidenceTier;
        const verdict: LegalVerdict = this.options.legal.checkTool({
            perspective: this.options.manifest.perspective,
            scenario: this.options.manifest.scenario,
            action: descriptor.name,
            effect: effectOf(descriptor.risk),
            ...(evidenceTier === (void 0)
                ? {}
                : { evidenceTier, evidenceFloor: this.options.manifest.evidenceFloor }),
            ...(this.options.approval === (void 0) ? {} : { approval: this.options.approval }),
        });
        const blocking: Violation[] = verdict.violations.filter((violation) => violation.level !== "minor");
        if (blocking.length > 0) {
            return { allowed: false, reason: blocking.map((violation) => violation.code).join(", ") };
        }
        if (verdict.violations.length > 0) {
            return { allowed: true, reason: verdict.violations.map((violation) => violation.code).join(", ") };
        }
        return { allowed: true };
    }
}
