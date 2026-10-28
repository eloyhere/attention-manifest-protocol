/**
 * The switch credential (spec section 5).
 *
 * A credential authorises a target perspective to look at a named scope for a
 * short time. It carries references, not content. It is issued by the general
 * manager and countersigned by legal and finance; all three sign-offs are
 * required before it is valid.
 *
 * A credential never replaces a manifest: the credential says what may be
 * seen, the manifest says what to look at, how deep and at what cost.
 */
import type { Digest, Id, Ref, Timestamp } from "../types/common.ts";
import type { BehaviorConstraints, CredentialBudget, ManifestRef, ModeWeights, PerspectiveId, ScenarioId, Signoff, SignoffRole, SignerInput } from "./types.ts";
import { GovernanceError, ScenarioIds, refKey } from "./types.ts";
import { normalizeModeWeights, resolveScenarioModes } from "./matrix.ts";
import type { ScenarioModePlan } from "./matrix.ts";
import { canIssueCredential, isKnownPerspective, perspective, requiresEscalation } from "./perspectives.ts";
import { digestOf } from "../semantic/canonical.ts";

export const DefaultCredentialTtlMs: number = 10 * 60 * 1000;

export const MaxCredentialTtlMs: number = 30 * 60 * 1000;

/**
 * A credential before the three sign-offs are attached.
 */
export interface CredentialDraft {
    id?: Id;
    from: PerspectiveId;
    to: PerspectiveId;
    reason: string;
    /**
     * What the target may read. Refs only; no bodies.
     */
    visibleScope: Ref[];
    /**
     * The payload handed over. Must be a subset of the visible scope.
     */
    payloadRefs: Ref[];
    budget: CredentialBudget;
    constraints: BehaviorConstraints;
    manifest: ManifestRef;
    scenario: ScenarioId;
    modes?: Partial<ModeWeights>;
    issuedAt: Timestamp;
    ttlMs?: number;
    notes?: string[];
}

/**
 * The signed credential.
 */
export interface SwitchCredential {
    kind: "switch-credential";
    id: Id;
    from: PerspectiveId;
    to: PerspectiveId;
    reason: string;
    visibleScope: Ref[];
    payloadRefs: Ref[];
    budget: CredentialBudget;
    constraints: BehaviorConstraints;
    manifest: ManifestRef;
    scenario: ScenarioId;
    modes: ModeWeights;
    issuedAt: Timestamp;
    expires: Timestamp;
    digest: Digest;
    signoffs: Signoff[];
    notes?: string[];
}

export interface CredentialRevocation {
    credentialId: Id;
    by: PerspectiveId;
    at: Timestamp;
    reason: string;
}

export interface CredentialVerdict {
    valid: boolean;
    code: string;
    detail: string;
}

export interface VerifyCredentialRequest {
    at: Timestamp;
    to: PerspectiveId;
    manifest?: ManifestRef;
    readRefs?: Ref[];
    revoked?: readonly CredentialRevocation[];
}

const SignoffOwner: Record<SignoffRole, PerspectiveId> = {
    issuer: "general-manager",
    legal: "legal",
    finance: "finance",
    board: "board",
    human: "shareholders",
};

let CredentialCounter: number = 0;

type CredentialDigestFn = (credential: Omit<SwitchCredential, "digest" | "signoffs"> | SwitchCredential) => Digest;

export const credentialDigest: CredentialDigestFn = (credential) => {
    const body: Record<string, unknown> = { ...credential };
    delete body.digest;
    delete body.signoffs;
    return digestOf(body);
};

const dedupeRefs: (refs: readonly Ref[]) => Ref[] = (refs: readonly Ref[]): Ref[] => {
    const seen: Set<string> = new Set<string>();
    const result: Ref[] = [];
    for (let index: number = 0; index < refs.length; index += 1) {
        const ref: Ref = refs[index];
        if (ref.id.length === 0) {
            throw new GovernanceError("credential-scope", "a credential ref needs a non-empty id");
        }
        const key: string = refKey(ref);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push({ ...ref });
    }
    return result;
};

/**
 * Issue a credential. Throws when the direction, the time window or the
 * three-party signature set is wrong; a credential that needs a fourth
 * signature (board authorisation for a strategic target) is issued with it.
 */
type IssueCredential = (draft: CredentialDraft, signers: readonly SignerInput[]) => SwitchCredential;

export const issueCredential: IssueCredential = (draft, signers) => {
    if (!isKnownPerspective(draft.from) || !isKnownPerspective(draft.to)) {
        throw new GovernanceError("unknown-perspective", `${draft.from} -> ${draft.to} is not a known direction`);
    }
    if (draft.from === draft.to) {
        throw new GovernanceError("credential-target", "a credential cannot switch a perspective to itself");
    }
    if (requiresEscalation(draft.from)) {
        throw new GovernanceError("credential-target", "strategic perspectives hand off through the escalation path, not a switch credential");
    }
    if (requiresEscalation(draft.to)) {
        const authorised: boolean = signers.some((signer: SignerInput) => signer.role === "board" || signer.role === "human");
        if (!authorised) {
            throw new GovernanceError("credential-target", `${draft.to} needs a board or human authorisation sign-off`);
        }
    } else if (!canIssueCredential(draft.from, draft.to)) {
        throw new GovernanceError("credential-target", `${draft.from} cannot hand off to ${draft.to} with a same-level credential`);
    }
    if (draft.reason.trim().length === 0) {
        throw new GovernanceError("credential-incomplete", "a credential needs a reason");
    }
    const visibleScope: Ref[] = dedupeRefs(draft.visibleScope);
    if (visibleScope.length === 0) {
        throw new GovernanceError("credential-scope", "a credential needs a visible scope");
    }
    const payloadRefs: Ref[] = dedupeRefs(draft.payloadRefs);
    const visibleKeys: Set<string> = new Set<string>(visibleScope.map((ref: Ref) => refKey(ref)));
    for (let index: number = 0; index < payloadRefs.length; index += 1) {
        if (!visibleKeys.has(refKey(payloadRefs[index]))) {
            throw new GovernanceError("credential-scope", `payload ref ${refKey(payloadRefs[index])} is outside the visible scope`);
        }
    }
    const issuedMs: number = Date.parse(draft.issuedAt);
    if (!Number.isFinite(issuedMs)) {
        throw new GovernanceError("credential-incomplete", "issuedAt must be a parseable timestamp");
    }
    const ttlMs: number = Math.min(MaxCredentialTtlMs, Math.max(1_000, draft.ttlMs ?? DefaultCredentialTtlMs));
    const plan: ScenarioModePlan = resolveScenarioModes(draft.scenario, draft.modes);
    const modes: ModeWeights = draft.modes === (void 0) ? plan.modes : normalizeModeWeights(draft.modes);
    CredentialCounter += 1;
    const unsigned: Omit<SwitchCredential, "digest" | "signoffs"> = {
        kind: "switch-credential",
        id: draft.id ?? `crd.${CredentialCounter}`,
        from: draft.from,
        to: draft.to,
        reason: draft.reason,
        visibleScope,
        payloadRefs,
        budget: { quota: { ...draft.budget.quota }, elasticity: draft.budget.elasticity },
        constraints: {
            allowed: [...draft.constraints.allowed],
            forbidden: [...draft.constraints.forbidden],
            obligations: [...draft.constraints.obligations],
            escalation: [...draft.constraints.escalation],
            evidence: draft.constraints.evidence,
        },
        manifest: { ...draft.manifest },
        scenario: draft.scenario,
        modes,
        issuedAt: draft.issuedAt,
        expires: new Date(issuedMs + ttlMs).toISOString(),
        ...(draft.notes === (void 0) ? {} : { notes: [...draft.notes] }),
    };
    const digest: Digest = credentialDigest(unsigned);
    const signoffs: Signoff[] = checkSignoffs(digest, signers, draft.to);
    return { ...unsigned, digest, signoffs };
};

type CheckSignoffs = (digest: Digest, signers: readonly SignerInput[], target: PerspectiveId) => Signoff[];

const checkSignoffs: CheckSignoffs = (digest, signers, target) => {
    const required: SignoffRole[] = ["issuer", "legal", "finance"];
    const seen: Set<string> = new Set<string>();
    const accepted: Signoff[] = [];
    for (let index: number = 0; index < signers.length; index += 1) {
        const signer: SignerInput = signers[index];
        if (signer.by === target) {
            throw new GovernanceError("credential-target", `${target} cannot sign its own credential`);
        }
        if (seen.has(signer.by)) {
            throw new GovernanceError("credential-incomplete", `${signer.by} signed twice`);
        }
        if (signer.by !== SignoffOwner[signer.role]) {
            throw new GovernanceError("credential-incomplete", `${signer.role} must be signed by ${SignoffOwner[signer.role]}`);
        }
        seen.add(signer.by);
        accepted.push({ role: signer.role, by: signer.by, at: signer.at, digest });
    }
    for (let index: number = 0; index < required.length; index += 1) {
        const role: SignoffRole = required[index];
        if (!accepted.some((signoff: Signoff) => signoff.role === role)) {
            throw new GovernanceError("credential-incomplete", `missing ${role} sign-off`);
        }
    }
    return accepted;
};

/**
 * Verify a credential against a request. Codes are stable so callers can map
 * them to receipts without parsing prose.
 */
type VerifyCredential = (credential: SwitchCredential, request: VerifyCredentialRequest) => CredentialVerdict;

export const verifyCredential: VerifyCredential = (credential, request) => {
    const digest: Digest = credentialDigest(credential);
    if (digest !== credential.digest) {
        return { valid: false, code: "credential-tampered", detail: "digest does not match the body" };
    }
    const revoked: CredentialRevocation | undefined = (request.revoked ?? []).find((entry: CredentialRevocation) => entry.credentialId === credential.id);
    if (revoked !== (void 0)) {
        return { valid: false, code: "credential-revoked", detail: `revoked by ${revoked.by}: ${revoked.reason}` };
    }
    if (credential.from === credential.to) {
        return { valid: false, code: "credential-target", detail: "a credential cannot switch a perspective to itself" };
    }
    if (credential.visibleScope.length === 0) {
        return { valid: false, code: "credential-scope", detail: "a credential needs a visible scope" };
    }
    if (credential.manifest.id.length === 0 || !Number.isInteger(credential.manifest.version) || credential.manifest.version < 1) {
        return { valid: false, code: "credential-manifest", detail: "the credential cites an invalid manifest reference" };
    }
    if (!ScenarioIds.includes(credential.scenario)) {
        return { valid: false, code: "credential-incomplete", detail: `${credential.scenario} is not a canonical scenario` };
    }
    const visible: Set<string> = new Set<string>(credential.visibleScope.map((ref: Ref) => refKey(ref)));
    for (let index: number = 0; index < credential.payloadRefs.length; index += 1) {
        if (!visible.has(refKey(credential.payloadRefs[index]))) {
            return { valid: false, code: "credential-scope", detail: "a payload ref is outside the visible scope" };
        }
    }
    if (credential.to !== request.to) {
        return { valid: false, code: "credential-target", detail: `credential is for ${credential.to}, not ${request.to}` };
    }
    if (!isKnownPerspective(credential.from) || !isKnownPerspective(credential.to)) {
        return { valid: false, code: "credential-target", detail: "the credential names an unknown perspective" };
    }
    if (requiresEscalation(credential.to) && !credential.signoffs.some((signoff: Signoff) => signoff.role === "board" || signoff.role === "human")) {
        return { valid: false, code: "credential-target", detail: `${credential.to} needs a board or human authorisation` };
    }
    const issued: number = Date.parse(credential.issuedAt);
    const expires: number = Date.parse(credential.expires);
    const at: number = Date.parse(request.at);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(at)) {
        return { valid: false, code: "credential-incomplete", detail: "unparseable time window" };
    }
    if (at < issued) {
        return { valid: false, code: "credential-not-yet-valid", detail: `issued at ${credential.issuedAt}` };
    }
    if (at >= expires) {
        return { valid: false, code: "credential-expired", detail: `expired at ${credential.expires}` };
    }
    if (request.manifest !== (void 0)) {
        if (request.manifest.id !== credential.manifest.id || request.manifest.version !== credential.manifest.version) {
            return { valid: false, code: "credential-manifest", detail: `manifest ${credential.manifest.id} v${credential.manifest.version} expected` };
        }
    }
    const scope: Set<string> = new Set<string>(credential.visibleScope.map((ref: Ref) => refKey(ref)));
    const requested: Ref[] = request.readRefs ?? [];
    for (let index: number = 0; index < requested.length; index += 1) {
        if (!scope.has(refKey(requested[index]))) {
            return { valid: false, code: "credential-scope", detail: `${refKey(requested[index])} is outside the visible scope` };
        }
    }
    const seen: Set<string> = new Set<string>();
    const roles: Set<string> = new Set<string>(credential.signoffs.map((signoff: Signoff) => signoff.role));
    for (let index: number = 0; index < credential.signoffs.length; index += 1) {
        const signoff: Signoff = credential.signoffs[index];
        if (signoff.digest !== digest) {
            return { valid: false, code: "credential-tampered", detail: `${signoff.role} signature covers another digest` };
        }
        if (signoff.by === credential.to) {
            return { valid: false, code: "credential-target", detail: "the target signed its own credential" };
        }
        if (signoff.by !== SignoffOwner[signoff.role]) {
            return { valid: false, code: "credential-incomplete", detail: `${signoff.role} was signed by ${signoff.by}` };
        }
        if (seen.has(signoff.by)) {
            return { valid: false, code: "credential-incomplete", detail: `${signoff.by} signed twice` };
        }
        seen.add(signoff.by);
    }
    for (let index: number = 0; index < 3; index += 1) {
        if (!roles.has(["issuer", "legal", "finance"][index])) {
            return { valid: false, code: "credential-incomplete", detail: "the triple sign-off is incomplete" };
        }
    }
    return { valid: true, code: "valid", detail: `${credential.id} authorises ${credential.to} until ${credential.expires}` };
};

/**
 * Minimal read check: the ref must be inside the visible scope.
 */
type CanRead = (credential: SwitchCredential, ref: Ref) => boolean;

export const canRead: CanRead = (credential, ref) => credential.visibleScope.some((entry: Ref) => refKey(entry) === refKey(ref));

/**
 * Revocation is an event, not an edit: the credential stays byte-identical and
 * the verifier consults the revocation list.
 */
type RevokeCredential = (credential: SwitchCredential, by: PerspectiveId, reason: string, at: Timestamp) => CredentialRevocation;

export const revokeCredential: RevokeCredential = (credential, by, reason, at) => {
    if (by !== "legal" && by !== "general-manager" && by !== "board") {
        throw new GovernanceError("approval-not-permitted", `${by} may not revoke a credential`);
    }
    return { credentialId: credential.id, by, at, reason };
};

/**
 * One-line audit text for a frame or receipt.
 */
type CredentialText = (credential: SwitchCredential) => string;

export const credentialSummary: CredentialText = (credential) =>
    `${credential.id} ${credential.from}->${credential.to} scope=${credential.visibleScope.length} expires=${credential.expires}`;

/**
 * The target perspective's layer, exposed so callers do not import the
 * registry just to log a handoff.
 */
export const credentialTargetLayer: CredentialText = (credential) => perspective(credential.to).layer;
