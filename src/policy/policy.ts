/**
 * AMP v0.1 — action policy: the execution point for W-1 and A-5.
 *
 * Architecture §6.1 makes the minimum evidence tier a function of how
 * reversible an action is; §3.8 requires that a claim driving an action be
 * `held` (W-1) and that the host, not the model, decides what may proceed
 * (A-5). This module turns those rules into a synchronous gate and issues the
 * host-controlled approvals that unlock the riskiest effect classes.
 *
 * Security model: `approve` and `revoke` are host APIs. They must not be
 * exposed to the model being governed. Approvals are bearer capabilities held
 * in engine-local state; the stored record is authoritative, so mutating a
 * returned copy cannot extend or widen an approval. Cross-process transfer of
 * approvals needs a signed envelope and is outside this P0 module.
 */
import type { Digest, Id, Ref, Tier, Timestamp } from "../types/common.ts";
import type { Claim } from "../warrant/epistemic.ts";
import { canAuthorizeEffect } from "../warrant/warrant.ts";

/**
 * The action taxonomy. Risk and required warrant increase down the list.
 */
export type EffectClass = "read" | "write-reversible" | "write-irreversible" | "spend" | "send" | "delete" | "deploy" | "permission" | "publish";

/**
 * Every effect class, ordered from least to most dangerous.
 */
export const EffectClasses: readonly EffectClass[] = [
    "read",
    "write-reversible",
    "write-irreversible",
    "spend",
    "send",
    "delete",
    "deploy",
    "permission",
    "publish",
];

/**
 * Effects that need a host approval by default.
 *
 * Reversible writes are intentionally excluded: a held T1 claim is enough for
 * a change that can be rolled back. Everything that can leak data, spend
 * money, destroy state, change authority, or make a public claim needs a
 * separate human/host decision.
 */
export const DefaultApprovalEffects: ReadonlySet<EffectClass> = new Set<EffectClass>([
    "write-irreversible",
    "spend",
    "send",
    "delete",
    "deploy",
    "permission",
    "publish",
]);

/**
 * A proposed action. The request is model-authored; the policy is not.
 */
export interface ActionRequest {
    /**
     * Optional correlation id for the receipt written by the caller.
     */
    id?: Id;
    /**
     * Stable action name, e.g. `deploy.rollback` or `mcp.github.create_issue`.
     */
    action: string;
    /**
     * What the action touches. Recorded for audit; bindings use action + digests.
     */
    target?: Ref;
    effect: EffectClass;
    /**
     * The warrant for the action. Required unless the read exemption applies.
     */
    claim?: Claim;
    /**
     * Caller-requested floor. It can RAISE the normative floor (for example T4
     * for cross-task reuse of a published fact) but can never lower it.
     */
    minTier?: Tier;
    /**
     * Digest of the tool definition the approval was issued against.
     */
    toolDigest?: Digest;
    /**
     * Digest of the exact arguments the approval was issued against.
     */
    argsDigest?: Digest;
    /**
     * Who asked for the action. Recorded for audit, not used as authorization.
     */
    requestedBy?: Ref;
}

/**
 * A host-issued approval for one action/effect binding.
 *
 * `scope` is an auditable list of granted identifiers (it defaults to the
 * action name). Authorization is enforced by `action`, `effect`, the optional
 * digests, expiry, revocation, and one-time consumption; `scope` is not
 * consulted for gating, so a host can record a richer capability description
 * without silently changing the binding.
 */
export interface Approval {
    id: Id;
    action: string;
    effect: EffectClass;
    scope: string[];
    toolDigest?: Digest;
    argsDigest?: Digest;
    approvedBy: Id;
    issued: Timestamp;
    expires: Timestamp;
    nonce: string;
}

/**
 * Gate outcomes. `approval_required` is deliberately distinct from `deny`:
 * the action is not authorized yet, but the host can unlock it by issuing an
 * approval. Callers must not collapse the two states.
 */
export type PolicyOutcome = "allow" | "deny" | "approval_required";

/**
 * The gate's answer. Denials are values, not exceptions (A-5).
 */
export interface PolicyVerdict {
    outcome: PolicyOutcome;
    /**
     * Machine-readable reason, e.g. `missing_claim` or `approval_expired`.
     */
    reason: string;
    /**
     * Effective minimum tier for this request after applying request.minTier.
     */
    minTier: Tier;
    /**
     * Set when the verdict references a known approval.
     */
    approvalId?: string;
}

export interface PolicyOptions {
    /**
     * Injected clock. Policy code never calls Date.now() directly.
     */
    now: () => Timestamp;
    /**
     * TTL used when approve() receives no ttlMs. Defaults to five minutes.
     */
    defaultTtlMs?: number;
    /**
     * Hard ceiling for every approval TTL. Defaults to fifteen minutes.
     */
    maxTtlMs?: number;
    /**
     * Effects that need approval. Defaults to DefaultApprovalEffects.
     */
    approvalEffects?: ReadonlySet<EffectClass>;
    /**
     * Whether reads may proceed without a claim. Defaults to true.
     */
    allowReadWithoutClaim?: boolean;
    /**
     * Optional host projection of warrant freshness. Only true passes; failures
     * deny before approval consumption. Omission preserves the existing gate.
     */
    isClaimCurrent?: (claim: Claim) => boolean;
}

/**
 * Host input to {@link PolicyEngine.approve}.
 */
export interface ApproveInput {
    action: string;
    effect: EffectClass;
    approvedBy: Id;
    /**
     * Requested lifetime; clamped to maxTtlMs.
     */
    ttlMs?: number;
    /**
     * Auditable grant description. Defaults to `[action]`.
     */
    scope?: string[];
    toolDigest?: Digest;
    argsDigest?: Digest;
}

interface ApprovalRecord {
    approval: Approval;
    consumed: boolean;
    revoked: boolean;
}

const TIER_ORDER: readonly Tier[] = ["T0", "T1", "T2", "T3", "T4"];
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_TTL_MS = 15 * 60_000;
const ID_BYTES = 16;
const NONCE_BYTES = 24;
const EFFECT_CLASS_SET: ReadonlySet<EffectClass> = new Set<EffectClass>(EffectClasses);

function positiveMs(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive finite number`);
    }
    return value;
}

/**
 * Browser and Node both expose `crypto.getRandomValues`; no Node import needed.
 */
function randomHex(bytes: number): string {
    if (!globalThis.crypto || typeof(globalThis.crypto.getRandomValues) !== "function") {
        throw new Error("crypto.getRandomValues is required to issue approvals");
    }
    const buffer = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buffer);
    return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isEffectClass(value: unknown): value is EffectClass {
    return typeof(value) === "string" && EFFECT_CLASS_SET.has(value as EffectClass);
}

function deny(reason: string, minTier: Tier, approvalId?: string): PolicyVerdict {
    return approvalId === (void 0) ? { outcome: "deny", reason, minTier } : { outcome: "deny", reason, minTier, approvalId };
}

function cloneApproval(approval: Approval): Approval {
    return { ...approval, scope: [...approval.scope] };
}

/**
 * Decide whether an action may proceed, and manage the approvals that unlock
 * the high-risk effect classes.
 *
 * Claim floors (architecture §6.1): read=T0, reversible write=T1,
 * irreversible write/spend/send=T2, delete/deploy/permission=T3,
 * publish=T3. Publish can be raised to T4 by request.minTier for cross-task
 * reuse. A request cannot lower its floor.
 */
export class PolicyEngine {
    private readonly now: () => Timestamp;
    private readonly defaultTtlMs: number;
    private readonly maxTtlMs: number;
    private readonly approvalEffects: ReadonlySet<EffectClass>;
    private readonly allowReadWithoutClaim: boolean;
    private readonly isClaimCurrent: ((claim: Claim) => boolean) | undefined;
    private readonly approvals = new Map<Id, ApprovalRecord>();

    constructor(options: PolicyOptions) {
        if (typeof(options.now) !== "function") {
            throw new TypeError("PolicyOptions.now must be a function");
        }
        this.now = options.now;
        this.defaultTtlMs = positiveMs(options.defaultTtlMs ?? DEFAULT_TTL_MS, "defaultTtlMs");
        this.maxTtlMs = positiveMs(options.maxTtlMs ?? DEFAULT_MAX_TTL_MS, "maxTtlMs");
        this.approvalEffects = new Set<EffectClass>(options.approvalEffects ?? DefaultApprovalEffects);
        this.allowReadWithoutClaim = options.allowReadWithoutClaim ?? true;
        this.isClaimCurrent = options.isClaimCurrent;
    }

    /**
     * Normative minimum tier for an effect (architecture §6.1).
     *
     * Publish is T3 for a first declaration. Cross-task reuse ("对外声明为事实、
     * 跨任务复用") can require T4; the caller raises the floor with
     * ActionRequest.minTier, never lowers it. Unknown runtime values fail closed
     * at T4.
     */
    minTierFor(effect: EffectClass): Tier {
        switch (effect) {
            case "read":
                return "T0";
            case "write-reversible":
                return "T1";
            case "write-irreversible":
            case "spend":
            case "send":
                return "T2";
            case "delete":
            case "deploy":
            case "permission":
                return "T3";
            case "publish":
                return "T3";
            default:
                return "T4";
        }
    }

    /**
     * Evaluate one action request.
     *
     * Evaluation order: effect validity, claim gate, approval gate. A claim is
     * required for every effect except read when allowReadWithoutClaim is true;
     * a present claim must be `held`, meet the effective tier, and pass
     * canAuthorizeEffect (confidence). For approval-required effects, a missing
     * approval returns `approval_required`; a supplied approval is validated and
     * then consumed atomically, so a replay or a second call is denied. Failed
     * validations do not burn the approval.
     *
     * Approvals passed for effects that do not require one are ignored and not
     * consumed; use {@link consume} when an explicit redemption is intended.
     */
    decide(request: ActionRequest, approval?: Approval | string): PolicyVerdict {
        if (!isEffectClass(request.effect)) {
            return deny("invalid_effect", "T4");
        }

        const minTier = this.effectiveMinTier(request);
        const claimVerdict = this.gateClaim(request, minTier);
        if (claimVerdict) {
            return claimVerdict;
        }

        if (!this.approvalEffects.has(request.effect)) {
            const reason = request.claim === (void 0) && request.effect === "read" ? "read_without_claim" : "allowed";
            return { outcome: "allow", reason, minTier };
        }

        if (approval === (void 0)) {
            return { outcome: "approval_required", reason: "approval_required", minTier };
        }

        const approvalId = typeof(approval) === "string" ? approval : approval.id;
        const supplied = typeof(approval) === "string" ? undefined : approval;
        return this.redeem(approvalId, request, minTier, supplied);
    }

    /**
     * Host-only: issue an approval.
     *
     * The id and nonce are 128/192-bit random values from crypto.getRandomValues.
     * The TTL defaults to defaultTtlMs and is clamped to maxTtlMs. The returned
     * approval is a copy; the engine's stored record remains authoritative.
     * Empty action/approvedBy, unknown effects and non-positive TTLs throw:
     * invalid host input is a programming error, not a policy denial.
     */
    approve(input: ApproveInput): Approval {
        if (typeof(input.action) !== "string" || input.action.trim().length === 0) {
            throw new TypeError("approval action must be a non-empty string");
        }
        if (!isEffectClass(input.effect)) {
            throw new TypeError(`unknown effect class: ${`${input.effect}`}`);
        }
        if (typeof(input.approvedBy) !== "string" || input.approvedBy.trim().length === 0) {
            throw new TypeError("approvedBy must be a non-empty id");
        }
        if (input.toolDigest !== (void 0) && input.toolDigest.trim().length === 0) {
            throw new TypeError("toolDigest must be non-empty when supplied");
        }
        if (input.argsDigest !== (void 0) && input.argsDigest.trim().length === 0) {
            throw new TypeError("argsDigest must be non-empty when supplied");
        }

        const scope = input.scope ?? [input.action];
        if (!Array.isArray(scope) || scope.some((entry) => typeof(entry) !== "string" || entry.length === 0)) {
            throw new TypeError("scope must be an array of non-empty strings");
        }

        const issued = this.now();
        const issuedMs = Date.parse(issued);
        if (!Number.isFinite(issuedMs)) {
            throw new Error("now() must return a parseable timestamp");
        }
        const ttlMs = this.ttlFor(input.ttlMs);
        if (!Number.isFinite(issuedMs + ttlMs)) {
            throw new RangeError("approval expiry is outside the representable range");
        }

        const approval: Approval = {
            id: this.freshId(),
            action: input.action,
            effect: input.effect,
            scope: [...scope],
            approvedBy: input.approvedBy,
            issued,
            expires: new Date(issuedMs + ttlMs).toISOString(),
            nonce: randomHex(NONCE_BYTES),
        };
        if (input.toolDigest !== (void 0)) {
            approval.toolDigest = input.toolDigest;
        }
        if (input.argsDigest !== (void 0)) {
            approval.argsDigest = input.argsDigest;
        }

        this.approvals.set(approval.id, { approval, consumed: false, revoked: false });
        return cloneApproval(approval);
    }

    /**
     * Explicitly redeem an approval for a request.
     *
     * Unlike decide(), consumption happens even when the effect would not
     * normally require an approval: this is the "burn this capability now"
     * operation. The claim gate still applies. Validation and consumption are
     * synchronous and therefore atomic in a single JS turn.
     */
    consume(approvalId: Id, request: ActionRequest): PolicyVerdict {
        if (!isEffectClass(request.effect)) {
            return deny("invalid_effect", "T4");
        }
        const minTier = this.effectiveMinTier(request);
        const claimVerdict = this.gateClaim(request, minTier);
        if (claimVerdict) {
            return claimVerdict;
        }
        return this.redeem(approvalId, request, minTier);
    }

    /**
     * Revoke an approval. Returns false for an unknown id; idempotent for a
     * known id (a second revoke returns true because the approval is revoked).
     */
    revoke(approvalId: Id): boolean {
        const record = this.approvals.get(approvalId);
        if (!record) {
            return false;
        }
        record.revoked = true;
        return true;
    }

    /**
     * Snapshot of known approvals as copies. Internal state is never exposed.
     */
    list(): Approval[] {
        return [...this.approvals.values()].map((record) => cloneApproval(record.approval));
    }

    /**
     * Validate an approval's binding to a request without consuming it.
     *
     * The stored record is authoritative: fields on the supplied copy cannot
     * extend its expiry or change its action/effect. The approval must have been
     * issued by this engine; unknown ids deny. This method checks the approval
     * only, not the request's claim.
     */
    checkApproval(approval: Approval, request: ActionRequest, at?: Timestamp): PolicyVerdict {
        const minTier = this.effectiveMinTier(request);
        const record = this.approvals.get(approval.id);
        if (!record) {
            return deny("approval_unknown", minTier, approval.id);
        }
        if (approval.nonce !== record.approval.nonce) {
            return deny("approval_invalid", minTier, approval.id);
        }
        return this.validateApproval(record, request, at ?? this.now());
    }

    private effectiveMinTier(request: ActionRequest): Tier {
        const floor = this.minTierFor(request.effect);
        if (request.minTier === (void 0)) {
            return floor;
        }
        return TIER_ORDER.indexOf(request.minTier) > TIER_ORDER.indexOf(floor) ? request.minTier : floor;
    }

    private gateClaim(request: ActionRequest, minTier: Tier): PolicyVerdict | undefined {
        const claim = request.claim;
        if (!claim) {
            if (request.effect === "read" && this.allowReadWithoutClaim) {
                return undefined;
            }
            return deny("missing_claim", minTier);
        }
        if (this.isClaimCurrent) {
            try {
                if (this.isClaimCurrent(claim) !== true) {
                    return deny("claim_requires_revalidation", minTier);
                }
            } catch {
                return deny("claim_freshness_unavailable", minTier);
            }
        }
        if (claim.status !== "held") {
            return deny("claim_not_held", minTier);
        }
        if (TIER_ORDER.indexOf(claim.tier) < TIER_ORDER.indexOf(minTier)) {
            return deny(`tier_below_minimum:${minTier}`, minTier);
        }
        if (!canAuthorizeEffect(claim, minTier)) {
            return deny("claim_low_confidence", minTier);
        }
        return undefined;
    }

    private redeem(approvalId: Id, request: ActionRequest, minTier: Tier, supplied?: Approval): PolicyVerdict {
        const record = this.approvals.get(approvalId);
        if (!record) {
            return deny("approval_unknown", minTier, approvalId);
        }
        if (supplied !== (void 0) && supplied.nonce !== record.approval.nonce) {
            return deny("approval_invalid", minTier, approvalId);
        }
        const verdict = this.validateApproval(record, request, this.now());
        if (verdict.outcome !== "allow") {
            return verdict;
        }
        record.consumed = true;
        return { outcome: "allow", reason: "approved", minTier, approvalId };
    }

    private validateApproval(record: ApprovalRecord, request: ActionRequest, at: Timestamp): PolicyVerdict {
        const approval = record.approval;
        const minTier = this.effectiveMinTier(request);

        if (record.revoked) {
            return deny("approval_revoked", minTier, approval.id);
        }
        if (record.consumed) {
            return deny("approval_consumed", minTier, approval.id);
        }
        if (approval.id.length === 0 || approval.nonce.length === 0 || approval.approvedBy.trim().length === 0) {
            return deny("approval_invalid", minTier, approval.id);
        }

        const issued = Date.parse(approval.issued);
        const expires = Date.parse(approval.expires);
        const current = Date.parse(at);
        if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(current)) {
            return deny("approval_invalid", minTier, approval.id);
        }
        if (current >= expires) {
            return deny("approval_expired", minTier, approval.id);
        }

        if (approval.action !== request.action) {
            return deny("approval_action_mismatch", minTier, approval.id);
        }
        if (approval.effect !== request.effect) {
            return deny("approval_effect_mismatch", minTier, approval.id);
        }
        if (approval.toolDigest !== (void 0) && request.toolDigest !== approval.toolDigest) {
            return deny("approval_digest_mismatch", minTier, approval.id);
        }
        if (approval.argsDigest !== (void 0) && request.argsDigest !== approval.argsDigest) {
            return deny("approval_digest_mismatch", minTier, approval.id);
        }

        return { outcome: "allow", reason: "approval_valid", minTier, approvalId: approval.id };
    }

    private ttlFor(requested?: number): number {
        return Math.min(positiveMs(requested ?? this.defaultTtlMs, "ttlMs"), this.maxTtlMs);
    }

    private freshId(): Id {
        let id = "";
        do {
            id = `apr.${randomHex(ID_BYTES)}`;
        } while (this.approvals.has(id));
        return id;
    }
}
