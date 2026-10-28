/**
 * Governed task: the bridge between the governance layer and the cognitive
 * runtime.
 *
 * The runtime still produces the answer; this adapter decides whether the task
 * may run at all (manifest and credential validity, legal freeze, budget),
 * audits the tools it called, charges the ledger, writes the board receipt and
 * asks the Bayesian control layer what to do next.
 *
 * It is an adapter, not a second runtime: no prompt building, no scoring and no
 * model call happen here.
 */
import type { Timestamp } from "../types/common.ts";
import type { BetaBelief } from "../bayes/engine.ts";
import type { EffectClass } from "../policy/policy.ts";
import type { ToolRisk } from "../module/tool/tool.ts";
import type { CognitiveRuntime, RuntimeToolCall, RuntimeTurn, TurnOverride } from "./cognitiveRuntime.ts";
import type { LlmUsage } from "../module/llm/llm.ts";
import type {
    AttentionManifest,
    BoardReceipt,
    BudgetBinding,
    ChargeRequest,
    ChargeResult,
    ContextLayers,
    ControlDecision,
    CredentialVerdict,
    GovernanceAuditEntry,
    GovernanceAuditLog,
    GovernanceBudget,
    LegalGate,
    LedgerSnapshot,
    LegalVerdict,
    LoadedManifest,
    SwitchCredential,
    VerificationVerdict,
} from "../governance/index.ts";
import {
    GovernanceError,
    decideControl,
    legacyInteractionMix,
    legacyScenarioMix,
    loadAttentionManifest,
    verifyAttentionManifest,
    verifyCredential,
} from "../governance/index.ts";

export interface GovernedTaskOptions {
    runtime: CognitiveRuntime;
    manifest: AttentionManifest;
    budget: GovernanceBudget;
    legal: LegalGate;
    context: ContextLayers;
    credential?: SwitchCredential;
    audit?: GovernanceAuditLog;
    now: () => Timestamp;
}

export interface CredentialCheck {
    id: string;
    verdict: string;
}

export interface GovernedTurnResult {
    turn: RuntimeTurn;
    manifest: LoadedManifest;
    credential?: CredentialCheck;
    legal: LegalVerdict[];
    charge: ChargeResult;
    control: ControlDecision;
    receipt: BoardReceipt;
    audit?: GovernanceAuditEntry;
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

/**
 * A task that cannot start is rejected before the model is called: a frozen
 * perspective, a tripped breaker, an expired manifest or a stale credential
 * never reach generation.
 *
 * Tool calls are audited after the runtime returns them. A true pre-call gate
 * belongs in the runtime's `ToolPolicy`; this adapter records the legal verdict
 * and can freeze the perspective for the next turn.
 */
export class GovernedTask {
    private readonly options: GovernedTaskOptions;

    constructor(options: GovernedTaskOptions) {
        if (typeof(options.now) !== "function") {
            throw new TypeError("GovernedTask requires a clock");
        }
        this.options = options;
    }

    manifest(): AttentionManifest {
        return this.options.manifest;
    }

    /**
     * Run one turn under the manifest, then settle it.
     */
    async turn(input: string, override: TurnOverride = {}): Promise<GovernedTurnResult> {
        const at: string = this.options.now();
        if (this.options.legal.isBlocked()) {
            throw new GovernanceError("legal-breaker", "the legal breaker is active");
        }
        if (this.options.legal.isFrozen(this.options.manifest.perspective)) {
            throw new GovernanceError("legal-frozen", `${this.options.manifest.perspective} is frozen`);
        }
        const verdict: VerificationVerdict = verifyAttentionManifest(this.options.manifest, at);
        if (!verdict.ok) {
            throw new GovernanceError(verdict.code === "manifest-expired" ? "manifest-expired" : "manifest-unsigned", verdict.detail ?? "manifest is not valid");
        }
        const loaded: LoadedManifest = loadAttentionManifest(this.options.manifest, { perspective: this.options.manifest.perspective, at });
        const binding: BudgetBinding = this.options.manifest.budget;
        const ledger: LedgerSnapshot =
            binding.scope === "agent"
                ? this.options.budget.snapshot("agent", binding.agent ?? "")
                : this.options.budget.snapshot("perspective", binding.perspective ?? this.options.manifest.perspective);
        if (ledger.frozen) {
            throw new GovernanceError("budget-frozen", `${binding.scope} ledger is frozen`);
        }
        let credentialVerdict: CredentialCheck | undefined;
        if (this.options.credential !== (void 0)) {
            const checked: CredentialVerdict = verifyCredential(this.options.credential, {
                at,
                to: this.options.manifest.perspective,
                manifest: { id: this.options.manifest.id, version: this.options.manifest.version },
            });
            if (!checked.valid) {
                throw new GovernanceError("credential-scope", `${checked.code}: ${checked.detail}`);
            }
            credentialVerdict = { id: this.options.credential.id, verdict: checked.code };
        }
        this.options.context.openPerspective(this.options.manifest.perspective, { id: this.options.manifest.id, version: this.options.manifest.version });
        const systemNote: string =
            `Governance: evidence floor ${this.options.manifest.evidenceFloor}; ` +
            `forbidden ${this.options.manifest.constraints.forbidden.slice(0, 3).join(", ")}.`;
        const governedOverride: TurnOverride = {
            ...override,
            scenarioMix: override.scenarioMix ?? legacyScenarioMix(this.options.manifest.scenario),
            interactionMix: override.interactionMix ?? legacyInteractionMix(this.options.manifest.modes),
            ...(override.systemNote === (void 0) ? { systemNote } : {}),
        };
        const turn: RuntimeTurn = await this.options.runtime.respond(input, governedOverride);
        const legal: LegalVerdict[] = [];
        const toolCalls: RuntimeToolCall[] = turn.toolCalls ?? [];
        for (let index: number = 0; index < toolCalls.length; index += 1) {
            const call: RuntimeToolCall = toolCalls[index];
            legal.push(
                this.options.legal.enforceTool({
                    perspective: this.options.manifest.perspective,
                    scenario: this.options.manifest.scenario,
                    action: call.name,
                    effect: effectOf(call.risk),
                }),
            );
        }
        const usage: LlmUsage | undefined = turn.usage;
        const tokens: number = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
        const chargeRequest: ChargeRequest =
            binding.scope === "agent"
                ? {
                      scope: "agent",
                      agent: binding.agent ?? "",
                      amount: { tokens },
                      reason: `turn ${turn.turnId}`,
                      requestedBy: this.options.manifest.perspective,
                  }
                : {
                      scope: "perspective",
                      perspective: binding.perspective ?? this.options.manifest.perspective,
                      amount: { tokens },
                      reason: `turn ${turn.turnId}`,
                      requestedBy: this.options.manifest.perspective,
                  };
        const charge: ChargeResult = this.options.budget.charge(chargeRequest);
        const overall: number = turn.answerScore?.overall ?? 0.5;
        const posterior: BetaBelief = { alpha: 1 + overall * 4, beta: 1 + (1 - overall) * 4 };
        const control: ControlDecision = decideControl({
            scenario: this.options.manifest.scenario,
            modes: this.options.manifest.modes,
            posterior,
            conflict: (turn.toolErrors ?? 0) > 0,
            voi: 1 - overall,
            openQuestions: 0,
        });
        const receipt: BoardReceipt = this.options.context.writeReceipt(this.options.manifest.perspective, {
            conclusion: turn.answer.slice(0, 180).length > 0 ? turn.answer.slice(0, 180) : "turn completed",
            evidence: loaded.focus.slice(0, 3).map((item) => item.target),
            confidence: Math.max(0, Math.min(1, overall)),
            budget: { tokens },
            manifest: { id: this.options.manifest.id, version: this.options.manifest.version },
            scenario: this.options.manifest.scenario,
            modes: this.options.manifest.modes,
            openQuestions: control.stop ? [] : ["review the residual uncertainty"],
        });
        const auditEntry: GovernanceAuditEntry | undefined =
            this.options.audit === (void 0)
                ? undefined
                : await this.options.audit.recordTurn({
                      turnId: turn.turnId,
                      perspective: this.options.manifest.perspective,
                      manifest: { id: this.options.manifest.id, version: this.options.manifest.version, digest: this.options.manifest.digest },
                      tokens,
                      charge,
                      control: { action: control.action, stop: control.stop, escalate: control.escalate, approvalRequired: control.approvalRequired },
                      receiptId: receipt.id,
                      ...(legal.flatMap((entry) => entry.violations.map((violation) => violation.code)).length === 0
                          ? {}
                          : { legalCodes: legal.flatMap((entry) => entry.violations.map((violation) => violation.code)) }),
                  });
        return {
            turn,
            manifest: loaded,
            ...(credentialVerdict === (void 0) ? {} : { credential: credentialVerdict }),
            legal,
            charge,
            control,
            receipt,
            ...(auditEntry === (void 0) ? {} : { audit: auditEntry }),
        };
    }
}
