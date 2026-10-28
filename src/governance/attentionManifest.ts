/**
 * The attention manifest (spec section 2): the signed declaration of where
 * attention goes, how deep, how much it may cost and when to stop.
 *
 * Lifecycle: derive -> issue -> load -> reassess ignored items -> update or
 * re-derive -> expire. The manifest never carries content, only refs, and it
 * never replaces a switch credential: the manifest says what to look at, the
 * credential says what may be looked at.
 */
import type { Budget, Digest, Id, Ref, Tier, Timestamp } from "../types/common.ts";
import type {
    ApprovalGrant,
    BehaviorConstraints,
    Elasticity,
    EvidenceFloor,
    LedgerScope,
    ModeWeights,
    PerspectiveId,
    ScenarioId,
    Sensitivity,
    Signoff,
    SignoffRole,
    SignerInput,
    VerificationVerdict,
} from "./types.ts";
import { FloorRank, FloorTier, GovernanceError, SensitivityRank, refKey } from "./types.ts";
import type { ScenarioModePlan } from "./matrix.ts";
import { driftRequiresApproval, modeDrift, normalizeModeWeights, resolveScenarioModes } from "./matrix.ts";
import { canApprove, perspective } from "./perspectives.ts";
import { strictestFloor } from "./legal.ts";
import { digestOf } from "../semantic/canonical.ts";

/**
 * What a manifest focuses on. `depth` is 1 (summary), 2 (standard) or 3
 * (detail); a focus item may expire before the manifest does.
 */
export interface FocusItem {
    target: Ref;
    category: "goal" | "subgoal" | "evidence" | "tool" | "memory";
    priority: number;
    depth: 1 | 2 | 3;
    ttlFrames?: number;
}

/**
 * Deliberate exclusion with an explicit revisit condition and cadence.
 */
export interface IgnoreItem {
    target: Ref;
    reason: string;
    /**
     * A named signal; when it fires and the cadence is due, the item returns
     * to the candidate pool.
     */
    revisitIf: string;
    everyFrames: number;
    lastFrame?: number;
}

/**
 * Which ledger funds the manifest, and how far it may flex.
 */
export interface BudgetBinding {
    scope: LedgerScope;
    perspective?: PerspectiveId;
    /**
     * Required when scope is `agent`; the agent's own ledger.
     */
    agent?: Id;
    cap: Budget;
    elasticity: Elasticity;
}

/**
 * A condition that must escalate to another perspective or to a human.
 */
export interface EscalationTrigger {
    condition: string;
    sensitivity: Sensitivity;
    to: PerspectiveId | "human";
}

/**
 * Where the manifest came from. The board strategy digest is mandatory so a
 * stale manifest is detectable.
 */
export interface ManifestDerivation {
    strategyVersion: number;
    strategyDigest: Digest;
    derivedAt: Timestamp;
    note?: string;
}

export interface AttentionManifestDraft {
    id: Id;
    perspective: PerspectiveId;
    scenario: ScenarioId;
    /**
     * Optional override; defaults to the scenario's matrix row.
     */
    modes?: Partial<ModeWeights>;
    focus: FocusItem[];
    ignore?: IgnoreItem[];
    priorityWeights?: Record<string, number>;
    budget: BudgetBinding;
    /**
     * A caller may raise the matrix floor, never lower it.
     */
    evidenceFloor?: EvidenceFloor;
    escalations?: EscalationTrigger[];
    constraints: BehaviorConstraints;
    derivation: ManifestDerivation;
    issuedAt: Timestamp;
    ttlMs?: number;
    note?: string;
}

/**
 * The derived, unsigned manifest. Issuing it adds version, expiry, digest and
 * counter-signatures.
 */
export interface DerivedAttentionManifest {
    draft: AttentionManifestDraft;
    plan: ScenarioModePlan;
    modes: ModeWeights;
    focus: FocusItem[];
    ignore: IgnoreItem[];
    escalations: EscalationTrigger[];
    evidenceFloor: EvidenceFloor;
    requiredTier: Tier;
    reassessEvery: number;
    elasticity: Elasticity;
    sensitivity: Sensitivity;
    rationale: string[];
}

export interface AttentionManifest {
    kind: "attention-manifest";
    id: Id;
    perspective: PerspectiveId;
    scenario: ScenarioId;
    modes: ModeWeights;
    focus: FocusItem[];
    ignore: IgnoreItem[];
    priorityWeights: Record<string, number>;
    budget: BudgetBinding;
    evidenceFloor: EvidenceFloor;
    requiredTier: Tier;
    reassessEvery: number;
    gateStrictness: "loose" | "medium" | "medium-strict" | "strict";
    elasticity: Elasticity;
    sensitivity: Sensitivity;
    escalations: EscalationTrigger[];
    constraints: BehaviorConstraints;
    derivation: ManifestDerivation;
    issuedAt: Timestamp;
    expires: Timestamp;
    version: number;
    parent?: Digest;
    digest: Digest;
    signatures: Signoff[];
    note?: string;
}

export const DefaultManifestTtlMs: number = 12 * 60 * 60 * 1000;

export const MaxManifestTtlMs: number = 7 * 24 * 60 * 60 * 1000;

/**
 * A manifest body without its seal; the digest covers exactly this shape.
 */
export type UnsignedManifest = Omit<AttentionManifest, "digest" | "signatures">;

/**
 * A load request: owner, expected scenario and the clock.
 */
export interface LoadManifestRequest {
    perspective: PerspectiveId;
    scenario?: ScenarioId;
    at: Timestamp;
}

const IgnoreCadenceCap: number = 60;

/**
 * Body used for digests: everything except the digest and the signatures.
 */
export const manifestDigest: (manifest: UnsignedManifest | AttentionManifest) => Digest = (manifest: UnsignedManifest | AttentionManifest): Digest => {
    const body: Record<string, unknown> = { ...manifest };
    delete body.digest;
    delete body.signatures;
    return digestOf(body);
};

const dedupeFocus: (items: readonly FocusItem[]) => FocusItem[] = (items: readonly FocusItem[]): FocusItem[] => {
    const seen: Set<string> = new Set<string>();
    const result: FocusItem[] = [];
    for (let index: number = 0; index < items.length; index += 1) {
        const item: FocusItem = items[index];
        if (item.target.id.length === 0) {
            throw new GovernanceError("manifest-scope", "a focus item needs a non-empty target id");
        }
        if (!Number.isFinite(item.priority) || item.priority < 0 || item.priority > 1) {
            throw new GovernanceError("manifest-scope", `priority for ${item.target.id} must be in [0, 1]`);
        }
        if (item.depth !== 1 && item.depth !== 2 && item.depth !== 3) {
            throw new GovernanceError("manifest-scope", `depth for ${item.target.id} must be 1, 2 or 3`);
        }
        const key: string = refKey(item.target);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push({ ...item, target: { ...item.target } });
    }
    return result;
};

const dedupeIgnore: (items: readonly IgnoreItem[], cadence: number) => IgnoreItem[] = (items: readonly IgnoreItem[], cadence: number): IgnoreItem[] => {
    const seen: Set<string> = new Set<string>();
    const result: IgnoreItem[] = [];
    for (let index: number = 0; index < items.length; index += 1) {
        const item: IgnoreItem = items[index];
        const key: string = refKey(item.target);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const everyFrames: number =
            Number.isFinite(item.everyFrames) && item.everyFrames > 0 ? Math.min(IgnoreCadenceCap, Math.round(item.everyFrames)) : cadence;
        result.push({
            target: { ...item.target },
            reason: item.reason,
            revisitIf: item.revisitIf,
            everyFrames,
            ...(item.lastFrame === (void 0) ? {} : { lastFrame: item.lastFrame }),
        });
    }
    return result;
};

const clampSensitivity: (value: Sensitivity, floor: Sensitivity) => Sensitivity = (value: Sensitivity, floor: Sensitivity): Sensitivity =>
    SensitivityRank[value] < SensitivityRank[floor] ? floor : value;

const defaultEscalations: (sensitivity: Sensitivity) => EscalationTrigger[] = (sensitivity: Sensitivity): EscalationTrigger[] => [
    { condition: "evidence below the manifest floor", sensitivity, to: "legal" },
    { condition: "budget hard ceiling reached", sensitivity, to: "finance" },
    { condition: "posterior uncertainty above 0.45", sensitivity, to: "supervisory" },
];

/**
 * Derive the matrix-consistent fields. This is the only place that decides the
 * evidence floor, revisit cadence, gate strictness and elasticity cap.
 */
export const deriveAttentionManifest: (draft: AttentionManifestDraft) => DerivedAttentionManifest = (
    draft: AttentionManifestDraft,
): DerivedAttentionManifest => {
    if (typeof(draft.id) !== "string" || draft.id.length === 0) {
        throw new GovernanceError("manifest-scope", "a manifest needs an id");
    }
    perspective(draft.perspective);
    if (draft.focus.length === 0) {
        throw new GovernanceError("manifest-scope", "a manifest needs at least one focus item");
    }
    if (draft.budget.scope === "reserve" || draft.budget.scope === "global") {
        throw new GovernanceError("manifest-scope", "a manifest binds a perspective or agent ledger, not the reserve or global ledger");
    }
    if (draft.budget.scope === "perspective" && draft.budget.perspective === (void 0)) {
        throw new GovernanceError("manifest-scope", "a perspective budget binding needs a perspective");
    }
    if (draft.budget.scope === "perspective" && draft.budget.perspective !== draft.perspective) {
        throw new GovernanceError("manifest-scope", "a perspective budget binding must match the manifest owner");
    }
    if (draft.budget.scope === "agent" && draft.budget.agent === (void 0)) {
        throw new GovernanceError("manifest-scope", "an agent budget binding needs an agent id");
    }
    const plan: ScenarioModePlan = resolveScenarioModes(draft.scenario, draft.modes);
    const modes: ModeWeights = plan.modes;
    let evidenceFloor: EvidenceFloor = strictestFloor(plan.evidenceFloor, draft.constraints.evidence);
    const rationale: string[] = [plan.rationale];
    if (draft.evidenceFloor !== (void 0)) {
        if (FloorRank[draft.evidenceFloor] > FloorRank[evidenceFloor]) {
            throw new GovernanceError(
                "approval-required",
                `the ${draft.scenario} matrix requires at least ${evidenceFloor}; a lower floor needs a legal waiver`,
            );
        }
        evidenceFloor = strictestFloor(evidenceFloor, draft.evidenceFloor);
        rationale.push(`caller floor ${draft.evidenceFloor} merged to ${evidenceFloor}`);
    }
    const elasticity: Elasticity = draft.budget.elasticity;
    const capRank: number = ["low", "medium", "high"].indexOf(elasticity);
    const planRank: number = ["low", "medium", "high"].indexOf(plan.elasticity);
    const effectiveElasticity: Elasticity = capRank > planRank ? plan.elasticity : elasticity;
    if (capRank > planRank) {
        rationale.push(`elasticity ${elasticity} clamped to ${plan.elasticity} by the matrix`);
    }
    const focus: FocusItem[] = dedupeFocus(draft.focus)
        .sort((left: FocusItem, right: FocusItem) => right.priority - left.priority)
        .slice(0, plan.focusLimit);
    if (draft.focus.length > focus.length) {
        rationale.push(`focus trimmed from ${draft.focus.length} to ${focus.length} by the ${plan.dominant} mode`);
    }
    const ignore: IgnoreItem[] = dedupeIgnore(draft.ignore ?? [], plan.revisitEvery);
    const triggers: EscalationTrigger[] = draft.escalations === (void 0) ? defaultEscalations(plan.sensitivity) : draft.escalations;
    const escalations: EscalationTrigger[] = triggers.map((trigger: EscalationTrigger) => ({
        condition: trigger.condition,
        to: trigger.to,
        sensitivity: clampSensitivity(trigger.sensitivity, plan.sensitivity),
    }));
    const priorityWeights: Record<string, number> = {};
    const priorities: Record<string, number> = draft.priorityWeights ?? {};
    for (let index: number = 0; index < Object.keys(priorities).length; index += 1) {
        const key: string = Object.keys(priorities)[index];
        const value: number = priorities[key];
        if (!Number.isFinite(value) || value < 0) {
            throw new GovernanceError("manifest-scope", `priority weight ${key} must be a non-negative number`);
        }
        priorityWeights[key] = value;
    }
    return {
        draft,
        plan,
        modes,
        focus,
        ignore,
        escalations,
        evidenceFloor,
        requiredTier: FloorTier[evidenceFloor],
        reassessEvery: plan.revisitEvery,
        elasticity: effectiveElasticity,
        sensitivity: plan.sensitivity,
        rationale,
    };
};

/**
 * A versioned manifest reference, safe to copy between layers.
 */
export interface ManifestLineage {
    version: number;
    parent: Digest;
}

/**
 * Issue a manifest. The three sign-offs are the issuer (general manager), legal
 * and finance; all three must sign the same digest, and no perspective may
 * sign its own manifest except the general manager's own.
 */
type IssueManifest = (derived: DerivedAttentionManifest, signers: readonly SignerInput[], lineage?: ManifestLineage) => AttentionManifest;

export const issueAttentionManifest: IssueManifest = (derived, signers, lineage) => {
    const draft: AttentionManifestDraft = derived.draft;
    const ttlMs: number = Math.min(MaxManifestTtlMs, Math.max(1_000, draft.ttlMs ?? DefaultManifestTtlMs));
    const issuedMs: number = Date.parse(draft.issuedAt);
    if (!Number.isFinite(issuedMs)) {
        throw new GovernanceError("manifest-scope", "issuedAt must be a parseable timestamp");
    }
    const unsigned: Omit<AttentionManifest, "digest" | "signatures"> = {
        kind: "attention-manifest",
        id: draft.id,
        perspective: draft.perspective,
        scenario: draft.scenario,
        modes: derived.modes,
        focus: derived.focus,
        ignore: derived.ignore,
        priorityWeights: { ...(draft.priorityWeights ?? {}) },
        budget: { ...draft.budget },
        evidenceFloor: derived.evidenceFloor,
        requiredTier: derived.requiredTier,
        reassessEvery: derived.reassessEvery,
        gateStrictness: derived.plan.gateStrictness,
        elasticity: derived.elasticity,
        sensitivity: derived.sensitivity,
        escalations: derived.escalations.map((trigger: EscalationTrigger) => ({ ...trigger })),
        constraints: {
            allowed: [...draft.constraints.allowed],
            forbidden: [...draft.constraints.forbidden],
            obligations: [...draft.constraints.obligations],
            escalation: [...draft.constraints.escalation],
            evidence: draft.constraints.evidence,
        },
        derivation: { ...draft.derivation },
        issuedAt: draft.issuedAt,
        expires: new Date(issuedMs + ttlMs).toISOString(),
        version: lineage?.version ?? 1,
        ...(lineage === (void 0) ? {} : { parent: lineage.parent }),
        ...(draft.note === (void 0) ? {} : { note: draft.note }),
    };
    const digest: Digest = manifestDigest(unsigned);
    const signatures: Signoff[] = checkSignoffs(unsigned, digest, signers, draft.perspective);
    return { ...unsigned, digest, signatures };
};

/**
 * Convenience builder used by tests and examples: derive then issue.
 */
type CreateManifest = (draft: AttentionManifestDraft, signers: readonly SignerInput[]) => AttentionManifest;

export const createAttentionManifest: CreateManifest = (draft, signers) => issueAttentionManifest(deriveAttentionManifest(draft), signers);

/**
 * Re-derive a manifest for a new scenario or a structural change. This is not
 * a patch: the version increments, the previous digest becomes `parent`, and
 * the three sign-offs must be renewed for the new body (spec 2.3, 12.7).
 */
export interface RederivePatch {
    scenario?: ScenarioId;
    modes?: Partial<ModeWeights>;
    focus?: FocusItem[];
    ignore?: IgnoreItem[];
    priorityWeights?: Record<string, number>;
    budget?: BudgetBinding;
    evidenceFloor?: EvidenceFloor;
    constraints?: BehaviorConstraints;
    escalation?: EscalationTrigger[];
    ttlMs?: number;
    note?: string;
}

type RederiveManifest = (manifest: AttentionManifest, patch: RederivePatch, signers: readonly SignerInput[], at: Timestamp) => AttentionManifest;

export const rederiveAttentionManifest: RederiveManifest = (manifest, patch, signers, at) => {
    if (isExpired(manifest, at)) {
        throw new GovernanceError("manifest-expired", `${manifest.id} expired at ${manifest.expires}`);
    }
    const draft: AttentionManifestDraft = {
        id: manifest.id,
        perspective: manifest.perspective,
        scenario: patch.scenario ?? manifest.scenario,
        modes: patch.modes ?? manifest.modes,
        focus: patch.focus ?? manifest.focus,
        ignore: patch.ignore ?? manifest.ignore,
        priorityWeights: patch.priorityWeights ?? manifest.priorityWeights,
        budget: patch.budget ?? manifest.budget,
        evidenceFloor: patch.evidenceFloor ?? manifest.evidenceFloor,
        escalations: patch.escalation ?? manifest.escalations,
        constraints: patch.constraints ?? manifest.constraints,
        derivation: { ...manifest.derivation, derivedAt: at, note: `re-derived from v${manifest.version}` },
        issuedAt: at,
        ...(patch.ttlMs === (void 0) ? {} : { ttlMs: patch.ttlMs }),
        ...(patch.note === (void 0) ? {} : { note: patch.note }),
    };
    const derived: DerivedAttentionManifest = deriveAttentionManifest(draft);
    return issueAttentionManifest(derived, signers, { version: manifest.version + 1, parent: manifest.digest });
};

const RequiresRole: Record<SignoffRole, PerspectiveId | undefined> = {
    issuer: "general-manager",
    legal: "legal",
    finance: "finance",
    board: "board",
    human: (void 0),
};

type CheckManifestSignoffs = (unsigned: UnsignedManifest, digest: Digest, signers: readonly SignerInput[], owner: PerspectiveId) => Signoff[];

const checkSignoffs: CheckManifestSignoffs = (unsigned, digest, signers, owner) => {
    const roles: SignoffRole[] = ["issuer", "legal", "finance"];
    const seen: Set<string> = new Set<string>();
    const accepted: Signoff[] = [];
    for (let index: number = 0; index < signers.length; index += 1) {
        const signer: SignerInput = signers[index];
        if (seen.has(signer.by)) {
            throw new GovernanceError("manifest-unsigned", `${signer.by} signed twice`);
        }
        const required: PerspectiveId | undefined = RequiresRole[signer.role];
        if (required !== (void 0) && signer.by !== required) {
            throw new GovernanceError("manifest-unsigned", `${signer.role} must be signed by ${required}`);
        }
        if (signer.by === owner && signer.role !== "issuer") {
            throw new GovernanceError("manifest-self-signed", `${owner} cannot counter-sign its own manifest`);
        }
        if (signer.by === owner && owner !== "general-manager") {
            throw new GovernanceError("manifest-self-signed", `${owner} cannot issue its own manifest`);
        }
        seen.add(signer.by);
        accepted.push({ role: signer.role, by: signer.by, at: signer.at, digest });
    }
    for (let index: number = 0; index < roles.length; index += 1) {
        const role: SignoffRole = roles[index];
        if (!accepted.some((signoff: Signoff) => signoff.role === role)) {
            throw new GovernanceError("manifest-unsigned", `missing ${role} sign-off`);
        }
    }
    if (unsigned.version < 1) {
        throw new GovernanceError("manifest-version-conflict", "manifest version must be positive");
    }
    return accepted;
};

/**
 * Verify that the manifest was not edited after issue.
 */
type VerifyManifest = (manifest: AttentionManifest, at?: Timestamp) => VerificationVerdict;

export const verifyAttentionManifest: VerifyManifest = (manifest, at) => {
    const digest: Digest = manifestDigest(manifest);
    if (digest !== manifest.digest) {
        return { ok: false, code: "manifest-tampered", detail: "digest does not match the body" };
    }
    const seen: Set<string> = new Set<string>();
    for (let index: number = 0; index < manifest.signatures.length; index += 1) {
        const signoff: Signoff = manifest.signatures[index];
        if (signoff.digest !== digest) {
            return { ok: false, code: "manifest-unsigned", detail: `${signoff.role} signed a different digest` };
        }
        const required: PerspectiveId | undefined = RequiresRole[signoff.role];
        if (manifest.version === 1) {
            if (required !== (void 0) && signoff.by !== required) {
                return { ok: false, code: "manifest-unsigned", detail: `${signoff.role} was signed by ${signoff.by}, not ${required}` };
            }
        } else if (signoff.role === "issuer") {
            if (signoff.by !== manifest.perspective && signoff.by !== "general-manager") {
                return { ok: false, code: "manifest-unsigned", detail: "a revision issuer must be the owner or the general manager" };
            }
        } else if (required !== (void 0) && signoff.by !== required) {
            return { ok: false, code: "manifest-unsigned", detail: `${signoff.role} was signed by ${signoff.by}, not ${required}` };
        }
        if (seen.has(signoff.by)) {
            return { ok: false, code: "manifest-unsigned", detail: `${signoff.by} signed twice` };
        }
        seen.add(signoff.by);
        if (manifest.version === 1 && signoff.by === manifest.perspective && manifest.perspective !== "general-manager") {
            return { ok: false, code: "manifest-self-signed", detail: `${manifest.perspective} signed its own manifest` };
        }
    }
    const roles: SignoffRole[] = manifest.version === 1 ? ["issuer", "legal", "finance"] : ["issuer"];
    for (let index: number = 0; index < roles.length; index += 1) {
        const role: SignoffRole = roles[index];
        if (!manifest.signatures.some((signoff: Signoff) => signoff.role === role && signoff.digest === digest)) {
            return { ok: false, code: "manifest-unsigned", detail: `missing ${role} sign-off` };
        }
    }
    if (manifest.version > 1) {
        const issuer: Signoff | undefined = manifest.signatures.find((signoff: Signoff) => signoff.role === "issuer" && signoff.digest === digest);
        if (issuer === (void 0) || (issuer.by !== manifest.perspective && issuer.by !== "general-manager")) {
            return { ok: false, code: "manifest-unsigned", detail: "the revision issuer is not the owner or the general manager" };
        }
    }
    if (at !== (void 0) && isExpired(manifest, at)) {
        return { ok: false, code: "manifest-expired", detail: `expired at ${manifest.expires}` };
    }
    return { ok: true };
};

export const isExpired: (manifest: AttentionManifest, at: Timestamp) => boolean = (manifest: AttentionManifest, at: Timestamp): boolean => {
    const expires: number = Date.parse(manifest.expires);
    const now: number = Date.parse(at);
    if (!Number.isFinite(expires) || !Number.isFinite(now)) {
        return true;
    }
    return now >= expires;
};

export interface LoadedManifest {
    manifest: AttentionManifest;
    focus: FocusItem[];
    ignore: IgnoreItem[];
    reason: string;
}

/**
 * Load a manifest into a perspective. Mismatched owner, scenario or expiry
 * fails closed.
 */
type LoadManifest = (manifest: AttentionManifest, request: LoadManifestRequest) => LoadedManifest;

export const loadAttentionManifest: LoadManifest = (manifest, request) => {
    if (manifest.perspective !== request.perspective) {
        throw new GovernanceError("manifest-scope", `${manifest.id} belongs to ${manifest.perspective}, not ${request.perspective}`);
    }
    if (request.scenario !== (void 0) && manifest.scenario !== request.scenario) {
        throw new GovernanceError("manifest-scope", `manifest scenario ${manifest.scenario} does not match ${request.scenario}`);
    }
    if (isExpired(manifest, request.at)) {
        throw new GovernanceError("manifest-expired", `${manifest.id} expired at ${manifest.expires}`);
    }
    return {
        manifest,
        focus: manifest.focus.map((item: FocusItem) => ({ ...item, target: { ...item.target } })),
        ignore: manifest.ignore.map((item: IgnoreItem) => ({ ...item, target: { ...item.target } })),
        reason: `loaded ${manifest.id} v${manifest.version} for ${manifest.perspective}: ${manifest.focus.length} focus, ${manifest.ignore.length} ignored`,
    };
};

export interface Reassessment {
    due: IgnoreItem[];
    promoted: IgnoreItem[];
    retained: IgnoreItem[];
    /**
     * A cadence-only working copy. Its digest is stale until the owner signs a
     * revision through {@link promoteIgnored}; callers must not verify it.
     */
    updated: AttentionManifest;
}

/**
 * Frame-settlement reassessment: an ignored item returns to the candidate pool
 * when its cadence is due and its named revisit signal fired.
 */
type Reassess = (manifest: AttentionManifest, frame: number, signals: readonly string[]) => Reassessment;

export const reassessIgnored: Reassess = (manifest, frame, signals) => {
    const due: IgnoreItem[] = [];
    const promoted: IgnoreItem[] = [];
    const retained: IgnoreItem[] = [];
    const remaining: IgnoreItem[] = [];
    for (let index: number = 0; index < manifest.ignore.length; index += 1) {
        const item: IgnoreItem = manifest.ignore[index];
        const last: number = item.lastFrame ?? 0;
        const isDue: boolean = frame - last >= item.everyFrames;
        if (isDue) {
            due.push(item);
            if (signals.includes(item.revisitIf)) {
                promoted.push(item);
                continue;
            }
            retained.push(item);
            remaining.push({ ...item, lastFrame: frame });
            continue;
        }
        remaining.push(item);
    }
    const updated: AttentionManifest = { ...manifest, ignore: remaining };
    return { due, promoted, retained, updated };
};

/**
 * Apply promotions to a manifest. This is an update, so the version and digest
 * change and the owner re-signs.
 */
type PromoteIgnored = (manifest: AttentionManifest, promoted: readonly IgnoreItem[], signer: SignerInput, at: Timestamp) => AttentionManifest;

export const promoteIgnored: PromoteIgnored = (manifest, promoted, signer, at) => {
    if (promoted.length === 0) {
        return manifest;
    }
    if (signer.by !== manifest.perspective && signer.by !== "general-manager") {
        throw new GovernanceError("manifest-unsigned", `${signer.by} may not re-sign ${manifest.perspective}'s manifest`);
    }
    if (signer.role !== "issuer") {
        throw new GovernanceError("manifest-unsigned", "a revision is signed with the issuer role");
    }
    const kept: Set<string> = new Set<string>(promoted.map((item: IgnoreItem) => refKey(item.target)));
    const focus: FocusItem[] = [...manifest.focus];
    for (let index: number = 0; index < promoted.length; index += 1) {
        const item: IgnoreItem = promoted[index];
        focus.push({ target: { ...item.target }, category: "evidence", priority: 0.6, depth: 2 });
    }
    const trimmed: FocusItem[] = focus
        .sort((left: FocusItem, right: FocusItem) => right.priority - left.priority)
        .slice(0, Math.max(1, manifest.focus.length + promoted.length));
    return signRevision(manifest, { focus: trimmed, ignore: manifest.ignore.filter((item: IgnoreItem) => !kept.has(refKey(item.target))) }, signer, at);
};

export interface ManifestPatch {
    focus?: FocusItem[];
    ignore?: IgnoreItem[];
    priorityWeights?: Record<string, number>;
    modes?: Partial<ModeWeights>;
    scenario?: ScenarioId;
    budget?: BudgetBinding;
    evidenceFloor?: EvidenceFloor;
    constraints?: BehaviorConstraints;
}

export interface ManifestUpdateApprovals {
    modeWeights?: ApprovalGrant;
    evidenceFloor?: ApprovalGrant;
    budget?: ApprovalGrant;
    constraints?: ApprovalGrant;
}

export interface ManifestUpdateContext {
    by: PerspectiveId;
    at: Timestamp;
    approvals?: ManifestUpdateApprovals;
    signoff: SignerInput;
}

type Granted = (approval: ApprovalGrant | undefined, subject: string, requester: PerspectiveId) => boolean;

const granted: Granted = (approval, subject, requester) => {
    if (approval === (void 0) || approval.granted !== true || approval.subject !== subject) {
        return false;
    }
    if (approval.by === requester) {
        throw new GovernanceError("approval-self", `${requester} cannot approve its own ${subject}`);
    }
    return canApprove(approval.by, approval.subject);
};

/**
 * Update a manifest. An execution perspective may change only its focus and
 * ignore lists; everything else needs the general manager plus the owning
 * department's approval. A scenario change is rejected: it must re-derive.
 */
type UpdateManifest = (manifest: AttentionManifest, patch: ManifestPatch, context: ManifestUpdateContext) => AttentionManifest;

export const updateAttentionManifest: UpdateManifest = (manifest, patch, context) => {
    if (context.by !== manifest.perspective && context.by !== "general-manager") {
        throw new GovernanceError("manifest-scope", `${context.by} may not update ${manifest.perspective}'s manifest`);
    }
    const ownerOnly: boolean = context.by === manifest.perspective && context.by !== "general-manager";
    if (
        ownerOnly &&
        (patch.scenario !== (void 0) ||
            patch.modes !== (void 0) ||
            patch.budget !== (void 0) ||
            patch.evidenceFloor !== (void 0) ||
            patch.constraints !== (void 0) ||
            patch.priorityWeights !== (void 0))
    ) {
        throw new GovernanceError("manifest-scope", "an execution perspective may update only focus and ignore");
    }
    if (patch.scenario !== (void 0) && patch.scenario !== manifest.scenario) {
        throw new GovernanceError("manifest-rederive-required", "a scenario change requires a fresh derivation");
    }
    let modes: ModeWeights = manifest.modes;
    if (patch.modes !== (void 0)) {
        const next: ModeWeights = normalizeModeWeights({ ...manifest.modes, ...patch.modes });
        if (driftRequiresApproval(manifest.modes, next) && !granted(context.approvals?.modeWeights, "mode.weights", manifest.perspective)) {
            throw new GovernanceError("approval-required", `mode drift ${modeDrift(manifest.modes, next).toFixed(2)} exceeds 0.15`);
        }
        modes = next;
    }
    let evidenceFloor: EvidenceFloor = manifest.evidenceFloor;
    if (patch.evidenceFloor !== (void 0) && patch.evidenceFloor !== manifest.evidenceFloor) {
        if (FloorRank[patch.evidenceFloor] > FloorRank[manifest.evidenceFloor]) {
            if (!granted(context.approvals?.evidenceFloor, "manifest.evidence-floor", manifest.perspective)) {
                throw new GovernanceError("approval-required", "lowering the evidence floor needs a legal approval");
            }
        }
        evidenceFloor = patch.evidenceFloor;
    }
    if (patch.budget !== (void 0) && !granted(context.approvals?.budget, "budget.elasticity", manifest.perspective)) {
        throw new GovernanceError("approval-required", "a budget binding change needs a finance approval");
    }
    if (patch.constraints !== (void 0) && !granted(context.approvals?.constraints, "manifest.constraints", manifest.perspective)) {
        throw new GovernanceError("approval-required", "a behaviour-constraint change needs a legal approval");
    }
    if (context.signoff.by !== context.by) {
        throw new GovernanceError("manifest-unsigned", "the revision signer must be the acting perspective");
    }
    if (context.signoff.role !== "issuer") {
        throw new GovernanceError("manifest-unsigned", "a revision is signed with the issuer role");
    }
    const revision: ManifestPatch = {
        ...patch,
        ...(patch.modes === (void 0) ? {} : { modes }),
        ...(patch.evidenceFloor === (void 0) ? {} : { evidenceFloor }),
    };
    return signRevision(manifest, revision, context.signoff, context.at);
};

type SignRevision = (manifest: AttentionManifest, patch: ManifestPatch, signer: SignerInput, at: Timestamp) => AttentionManifest;

const signRevision: SignRevision = (manifest, patch, signer, at) => {
    const nextModes: ModeWeights = patch.modes === (void 0) ? manifest.modes : normalizeModeWeights(patch.modes);
    const nextPlan: ScenarioModePlan | undefined = patch.modes === (void 0) ? (void 0) : resolveScenarioModes(manifest.scenario, nextModes);
    const body: Record<string, unknown> = { ...manifest };
    delete body.digest;
    delete body.signatures;
    const base: Omit<AttentionManifest, "digest" | "signatures"> = body as unknown as Omit<AttentionManifest, "digest" | "signatures">;
    const unsigned: Omit<AttentionManifest, "digest" | "signatures"> = {
        ...base,
        ...(patch.focus === (void 0) ? {} : { focus: dedupeFocus(patch.focus) }),
        ...(patch.ignore === (void 0) ? {} : { ignore: dedupeIgnore(patch.ignore, manifest.reassessEvery) }),
        ...(patch.priorityWeights === (void 0) ? {} : { priorityWeights: { ...patch.priorityWeights } }),
        ...(patch.modes === (void 0) ? {} : { modes: nextModes }),
        ...(nextPlan === (void 0) ? {} : { gateStrictness: nextPlan.gateStrictness, reassessEvery: nextPlan.revisitEvery, elasticity: nextPlan.elasticity }),
        ...(patch.budget === (void 0) ? {} : { budget: { ...patch.budget } }),
        ...(patch.evidenceFloor === (void 0) ? {} : { evidenceFloor: patch.evidenceFloor, requiredTier: FloorTier[patch.evidenceFloor] }),
        ...(patch.constraints === (void 0) ? {} : { constraints: { ...patch.constraints } }),
        version: manifest.version + 1,
        parent: manifest.digest,
        issuedAt: at,
    };
    const digest: Digest = manifestDigest(unsigned);
    const signoff: Signoff = { role: signer.role, by: signer.by, at: signer.at, digest };
    return { ...unsigned, digest, signatures: [signoff] };
};

/**
 * Contract the manifest when the task phase ends: budget is released and the
 * manifest stops authorising attention.
 */
type ExpireManifest = (manifest: AttentionManifest, at: Timestamp) => AttentionManifest;

export const expireAttentionManifest: ExpireManifest = (manifest, at) => ({
    ...manifest,
    expires: at,
});

/**
 * Human-readable summary for a receipt or board note.
 */
type ManifestText = (manifest: AttentionManifest) => string;

export const manifestSummary: ManifestText = (manifest) =>
    `${manifest.id} v${manifest.version} ${manifest.scenario} [${manifest.modes.affect.toFixed(2)}/${manifest.modes.think.toFixed(2)}/${manifest.modes.diverge.toFixed(2)}/${manifest.modes.converge.toFixed(2)}] floor=${manifest.evidenceFloor} focus=${manifest.focus.length} ignore=${manifest.ignore.length}`;
