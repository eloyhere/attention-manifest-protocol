/**
 * Ed25519 adapter for governance objects.
 *
 * Governance sign-offs answer "which department approved this digest"; this
 * module answers "who can prove they hold the key for that department". The two
 * layers are deliberately separate: a deployment may run the governance layer
 * without cryptography, and it may attach cryptography only where the host can
 * manage keys.
 *
 * A signature covers `{signer, subject, subjectId, subjectVersion, digest}`, so a
 * signature cannot be transplanted from one manifest or credential to another.
 */
import type { Digest, Id } from "../types/common.ts";
import type { KeyPair } from "../manifest/sign.ts";
import { generateSigningKey } from "../manifest/sign.ts";
import { canonical } from "../semantic/canonical.ts";
import { GovernanceError } from "./types.ts";

const Encoder: TextEncoder = new TextEncoder();

const toBase64Url: (bytes: ArrayBuffer) => string = (bytes: ArrayBuffer): string => {
    const view: Uint8Array = new Uint8Array(bytes);
    let binary: string = "";
    for (let index: number = 0; index < view.length; index += 1) {
        binary += String.fromCharCode(view[index]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url: (text: string) => BufferSource = (text: string): BufferSource => {
    const padded: string = text.replace(/-/g, "+").replace(/_/g, "/");
    const pad: string = padded.length % 4 ? "=".repeat(4 - (padded.length % 4)) : "";
    const binary: string = atob(padded + pad);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0)) as unknown as BufferSource;
};

/**
 * Generic canonical-value signatures for transport envelopes and audit
 * checkpoints. The governance-specific functions below bind a digest to a
 * subject; these helpers only sign the canonical JSON of `value`.
 */
export const signCanonicalValue: (value: unknown, key: KeyPair) => Promise<string> = async (value: unknown, key: KeyPair): Promise<string> => {
    const signature: ArrayBuffer = await crypto.subtle.sign("Ed25519", key.privateKey, Encoder.encode(canonical(value)) as unknown as BufferSource);
    return toBase64Url(signature);
};

type VerifyCanonicalFn = (value: unknown, signature: string, publicKey: CryptoKey) => Promise<boolean>;

export const verifyCanonicalValue: VerifyCanonicalFn = async (value, signature, publicKey) => crypto.subtle.verify("Ed25519", publicKey, fromBase64Url(signature), Encoder.encode(canonical(value)) as unknown as BufferSource);

export interface GovernanceSigner {
    signer: string;
    key: KeyPair;
}

export interface GovernanceCryptoSignature {
    signer: string;
    kid: Id;
    alg: "ed25519";
    sig: string;
    digest: Digest;
}

export type GovernanceSubject = "attention-manifest" | "switch-credential" | "audit-checkpoint" | "cooperation-message";

export interface GovernanceSignatureBundle {
    kind: "governance-signatures";
    subject: GovernanceSubject;
    subjectId: string;
    subjectVersion?: number;
    subjectDigest: Digest;
    signatures: GovernanceCryptoSignature[];
}

export interface GovernanceVerification {
    ok: boolean;
    reasons: string[];
}

/**
 * Public keys keyed by the governance signer name. Revocation is separate from
 * deletion, so a revoked signer fails closed even if its key is still present.
 *
 * Rotation keeps the old key as a candidate until `retiresAt`, so signatures
 * made before the rotation still verify during the overlap window.
 */
export interface GovernanceKeyRecord {
    kid?: Id;
    key: CryptoKey;
    addedAt?: number;
    retiresAt?: number;
}

export type KeyringAction = "add" | "rotate" | "revoke" | "revoke-kid" | "prune";

export interface KeyringEvent {
    action: KeyringAction;
    signer: string;
    kid?: Id;
    at: number;
}

export type KeyringEventSink = (event: KeyringEvent) => void;

export class GovernanceKeyring {
    private readonly keys = new Map<string, GovernanceKeyRecord[]>();
    private readonly revoked = new Set<string>();
    private readonly revokedKids = new Set<string>();
    private readonly onEvent?: KeyringEventSink;

    constructor(options: { onEvent?: KeyringEventSink } = {}) {
        this.onEvent = options.onEvent;
    }

    private emit(action: KeyringAction, signer: string, at: number, kid?: Id): void {
        this.onEvent?.({
            action,
            signer,
            ...(kid === (void 0) ? {} : { kid }),
            at,
        });
    }

    add(signer: string, publicKey: CryptoKey, record: { kid?: Id; at?: number; retiresAt?: number; } = {}): void {
        const existing: GovernanceKeyRecord[] = this.keys.get(signer) ?? [];
        existing.push({
            key: publicKey,
            ...(record.kid === (void 0) ? {} : { kid: record.kid }),
            ...(record.at === (void 0) ? {} : { addedAt: record.at }),
            ...(record.retiresAt === (void 0) ? {} : { retiresAt: record.retiresAt }),
        });
        this.keys.set(signer, existing);
        this.emit("add", signer, record.at ?? Date.now(), record.kid);
    }

    /**
     * Add a new key and retire the previous ones after the overlap window.
     */
    rotate(signer: string, publicKey: CryptoKey, options: { kid?: Id; at: number; overlapMs?: number; }): void {
        const overlapMs: number = Math.max(0, options.overlapMs ?? 0);
        const existing: GovernanceKeyRecord[] = this.keys.get(signer) ?? [];
        for (let index: number = 0; index < existing.length; index += 1) {
            if (existing[index].retiresAt === (void 0)) {
                existing[index].retiresAt = options.at + overlapMs;
            }
        }
        existing.push({
            key: publicKey,
            ...(options.kid === (void 0) ? {} : { kid: options.kid }),
            addedAt: options.at,
        });
        this.keys.set(signer, existing);
        this.emit("rotate", signer, options.at, options.kid);
    }

    revoke(signer: string): void {
        this.revoked.add(signer);
        this.emit("revoke", signer, Date.now());
    }

    revokeKid(signer: string, kid: Id): void {
        this.revokedKids.add(`${signer}#${kid}`);
        this.emit("revoke-kid", signer, Date.now(), kid);
    }

    prune(at: number): void {
        const entries: Array<[string, GovernanceKeyRecord[]]> = [...this.keys.entries()];
        for (let index: number = 0; index < entries.length; index += 1) {
            const signer: string = entries[index][0];
            const records: GovernanceKeyRecord[] = entries[index][1];
            this.keys.set(
                signer,
                records.filter((record) => record.retiresAt === (void 0) || record.retiresAt > at),
            );
        }
        this.emit("prune", "", at);
    }

    candidates(signer: string, kid?: Id, at: number = Date.now()): CryptoKey[] {
        if (this.revoked.has(signer)) {
            return [];
        }
        const records: GovernanceKeyRecord[] = (this.keys.get(signer) ?? []).filter(
            (record) => (record.retiresAt === (void 0) || record.retiresAt > at) && !this.revokedKids.has(`${signer}#${record.kid ?? ""}`),
        );
        if (kid !== (void 0)) {
            const matching: GovernanceKeyRecord[] = records.filter((record) => record.kid === kid);
            if (matching.length > 0) {
                return matching.map((record) => record.key);
            }
        }
        return records.map((record) => record.key);
    }

    get(signer: string, kid?: Id, at: number = Date.now()): CryptoKey | undefined {
        return this.candidates(signer, kid, at)[0];
    }
}

type GenerateSignersFn = (signers: readonly string[], kidPrefix?: string) => Promise<GovernanceSigner[]>;

export const generateGovernanceSigners: GenerateSignersFn = async (signers, kidPrefix = "gov") => {
    const result: GovernanceSigner[] = [];
    for (let index: number = 0; index < signers.length; index += 1) {
        const signer: string = signers[index];
        result.push({ signer, key: await generateSigningKey(`${kidPrefix}.${signer}`) });
    }
    return result;
};

const signingBytes: (input: { signer: string; subject: GovernanceSubject; subjectId: string; subjectVersion?: number; digest: Digest; }) => BufferSource = (input: {
    signer: string;
    subject: GovernanceSubject;
    subjectId: string;
    subjectVersion?: number;
    digest: Digest;
}): BufferSource =>
    Encoder.encode(
        canonical({
            signer: input.signer,
            subject: input.subject,
            subjectId: input.subjectId,
            subjectVersion: input.subjectVersion ?? null,
            digest: input.digest,
        }),
    ) as unknown as BufferSource;

export const signGovernanceDigest: (input: {
    signer: GovernanceSigner;
    subject: GovernanceSubject;
    subjectId: string;
    subjectVersion?: number;
    digest: Digest;
}) => Promise<GovernanceCryptoSignature> = async (input: {
    signer: GovernanceSigner;
    subject: GovernanceSubject;
    subjectId: string;
    subjectVersion?: number;
    digest: Digest;
}): Promise<GovernanceCryptoSignature> => {
    const signature: ArrayBuffer = await crypto.subtle.sign(
        "Ed25519",
        input.signer.key.privateKey,
        signingBytes({
            signer: input.signer.signer,
            subject: input.subject,
            subjectId: input.subjectId,
            ...(input.subjectVersion === (void 0) ? {} : { subjectVersion: input.subjectVersion }),
            digest: input.digest,
        }),
    );
    return {
        signer: input.signer.signer,
        kid: input.signer.key.kid,
        alg: "ed25519",
        sig: toBase64Url(signature),
        digest: input.digest,
    };
};

export const verifyGovernanceSignature: (input: {
    signature: GovernanceCryptoSignature;
    subject: GovernanceSubject;
    subjectId: string;
    subjectVersion?: number;
    digest: Digest;
    keyring: GovernanceKeyring;
}) => Promise<GovernanceVerification> = async (input: {
    signature: GovernanceCryptoSignature;
    subject: GovernanceSubject;
    subjectId: string;
    subjectVersion?: number;
    digest: Digest;
    keyring: GovernanceKeyring;
}): Promise<GovernanceVerification> => {
    if (input.signature.alg !== "ed25519") {
        return { ok: false, reasons: [`unsupported algorithm ${input.signature.alg}`] };
    }
    if (input.signature.digest !== input.digest) {
        return { ok: false, reasons: ["signature covers a different digest"] };
    }
    const candidates: CryptoKey[] = input.keyring.candidates(input.signature.signer, input.signature.kid);
    if (candidates.length === 0) {
        return { ok: false, reasons: [`unknown or revoked signer ${input.signature.signer}`] };
    }
    for (let index: number = 0; index < candidates.length; index += 1) {
        const valid: boolean = await crypto.subtle.verify(
            "Ed25519",
            candidates[index],
            fromBase64Url(input.signature.sig),
            signingBytes({
                signer: input.signature.signer,
                subject: input.subject,
                subjectId: input.subjectId,
                ...(input.subjectVersion === (void 0) ? {} : { subjectVersion: input.subjectVersion }),
                digest: input.digest,
            }),
        );
        if (valid) {
            return { ok: true, reasons: [] };
        }
    }
    return { ok: false, reasons: ["signature does not verify"] };
};

export const signGovernanceObject: (input: {
    subject: GovernanceSubject;
    subjectId: string;
    subjectVersion?: number;
    digest: Digest;
    signers: readonly GovernanceSigner[];
}) => Promise<GovernanceSignatureBundle> = async (input: {
    subject: GovernanceSubject;
    subjectId: string;
    subjectVersion?: number;
    digest: Digest;
    signers: readonly GovernanceSigner[];
}): Promise<GovernanceSignatureBundle> => {
    if (input.signers.length === 0) {
        throw new GovernanceError("manifest-unsigned", "at least one cryptographic signer is required");
    }
    const seen: Set<string> = new Set<string>();
    const signatures: GovernanceCryptoSignature[] = [];
    for (let index: number = 0; index < input.signers.length; index += 1) {
        const signer: GovernanceSigner = input.signers[index];
        if (seen.has(signer.signer)) {
            throw new GovernanceError("manifest-unsigned", `${signer.signer} signed twice`);
        }
        seen.add(signer.signer);
        signatures.push(
            await signGovernanceDigest({
                signer,
                subject: input.subject,
                subjectId: input.subjectId,
                ...(input.subjectVersion === (void 0) ? {} : { subjectVersion: input.subjectVersion }),
                digest: input.digest,
            }),
        );
    }
    return {
        kind: "governance-signatures",
        subject: input.subject,
        subjectId: input.subjectId,
        ...(input.subjectVersion === (void 0) ? {} : { subjectVersion: input.subjectVersion }),
        subjectDigest: input.digest,
        signatures,
    };
};

export const verifyGovernanceBundle: (input: {
    bundle: GovernanceSignatureBundle;
    expected: { subject: GovernanceSubject; subjectId: string; subjectVersion?: number; digest: Digest; };
    keyring: GovernanceKeyring;
    requiredSigners?: readonly string[];
}) => Promise<GovernanceVerification> = async (input: {
    bundle: GovernanceSignatureBundle;
    expected: { subject: GovernanceSubject; subjectId: string; subjectVersion?: number; digest: Digest; };
    keyring: GovernanceKeyring;
    requiredSigners?: readonly string[];
}): Promise<GovernanceVerification> => {
    const reasons: string[] = [];
    if (input.bundle.kind !== "governance-signatures") {
        reasons.push("not a governance signature bundle");
    }
    if (input.bundle.subject !== input.expected.subject) {
        reasons.push(`subject mismatch: ${input.bundle.subject}`);
    }
    if (input.bundle.subjectId !== input.expected.subjectId) {
        reasons.push(`subject id mismatch: ${input.bundle.subjectId}`);
    }
    if (input.bundle.subjectVersion !== input.expected.subjectVersion) {
        reasons.push("subject version mismatch");
    }
    if (input.bundle.subjectDigest !== input.expected.digest) {
        reasons.push("bundle digest does not match the subject");
    }
    if (input.bundle.signatures.length === 0) {
        reasons.push("bundle has no signatures");
    }
    const seen: Set<string> = new Set<string>();
    for (let index: number = 0; index < input.bundle.signatures.length; index += 1) {
        const signature: GovernanceCryptoSignature = input.bundle.signatures[index];
        if (seen.has(signature.signer)) {
            reasons.push(`${signature.signer} signed twice`);
            continue;
        }
        seen.add(signature.signer);
        const verified: GovernanceVerification = await verifyGovernanceSignature({
            signature,
            subject: input.expected.subject,
            subjectId: input.expected.subjectId,
            ...(input.expected.subjectVersion === (void 0) ? {} : { subjectVersion: input.expected.subjectVersion }),
            digest: input.expected.digest,
            keyring: input.keyring,
        });
        reasons.push(...verified.reasons);
    }
    if (input.requiredSigners !== (void 0)) {
        for (let index: number = 0; index < input.requiredSigners.length; index += 1) {
            const required: string = input.requiredSigners[index];
            if (!seen.has(required)) {
                reasons.push(`missing required signer ${required}`);
            }
        }
    }
    return { ok: reasons.length === 0, reasons };
};
