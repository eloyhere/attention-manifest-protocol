import type { Digest, Id, Signature } from "../types/common.ts";
import type { Manifest } from "./manifest.ts";
import { canonical, digestOf } from "../semantic/canonical.ts";

type UnsignedManifest = Omit<Manifest, "digest" | "signatures">;

type ManifestWithDigest = UnsignedManifest & {
    digest: Digest;
};

type SignedManifestBody = Omit<Manifest, "signatures">;

type SignManifestFn = (unsigned: UnsignedManifest, key: KeyPair) => Promise<Manifest>;

type VerifyManifestFn = (manifest: Manifest, publicKey: CryptoKey) => Promise<VerifyResult>;

type VerifyWithRegistryFn = (manifest: Manifest, registry: KeyRegistry) => Promise<VerifyResult>;

const Encoder: TextEncoder = new TextEncoder();

export interface KeyPair {
    kid: Id;
    publicKey: CryptoKey;
    privateKey: CryptoKey;
}

const toBase64Url: (bytes: ArrayBuffer) => string = (bytes: ArrayBuffer): string => {
    const view: Uint8Array = new Uint8Array(bytes);
    let binary: string = "";
    for (let i: number = 0; i < view.length; i += 1) {
        const byte: number = view[i];
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url: (text: string) => BufferSource = (text: string): BufferSource => {
    const padded: string = text.replace(/-/g, "+").replace(/_/g, "/");
    const pad: string = padded.length % 4 ? "=".repeat(4 - (padded.length % 4)) : "";
    const binary: string = atob(padded + pad);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0)) as unknown as BufferSource;
};

export const generateSigningKey: (kid: Id) => Promise<KeyPair> = async (kid: Id): Promise<KeyPair> => {
    const pair: CryptoKeyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return { kid, publicKey: pair.publicKey, privateKey: pair.privateKey };
};

/**
 * Everything except `signatures` is signed, `digest` included.
 */
const signingBytes: (manifest: SignedManifestBody) => BufferSource = (manifest: SignedManifestBody): BufferSource => {
    return Encoder.encode(canonical(manifest)) as unknown as BufferSource;
};

export const contentDigest: (manifest: UnsignedManifest) => Digest = (manifest: UnsignedManifest): Digest => {
    return digestOf(manifest);
};

/**
 * Signs the canonical manifest. The digest is recomputed here, so a caller
 * cannot sign a stale digest.
 */
export const signManifest: SignManifestFn = async (unsigned: UnsignedManifest, key: KeyPair): Promise<Manifest> => {
    const digest: Digest = contentDigest(unsigned);
    const withDigest: ManifestWithDigest = { ...unsigned, digest };
    const signature: ArrayBuffer = await crypto.subtle.sign("Ed25519", key.privateKey, signingBytes(withDigest));
    return {
        ...withDigest,
        signatures: [{ role: "self", alg: "ed25519", kid: key.kid, sig: toBase64Url(signature) }],
    };
};

export interface VerifyResult {
    ok: boolean;
    reasons: string[];
}

/**
 * Recomputes the digest before verifying: a tampered body fails even with a valid old signature.
 */
export const verifyManifest: VerifyManifestFn = async (manifest: Manifest, publicKey: CryptoKey): Promise<VerifyResult> => {
    const reasons: string[] = [];
    const { digest, signatures, ...rest }: Manifest = manifest;

    if (contentDigest(rest) !== digest) {
        reasons.push("digest does not cover the manifest content");
    }

    const signature: Signature | undefined = signatures.find((entry) => entry.role === "self");
    if (!signature) {
        reasons.push("missing self signature");
        return { ok: false, reasons };
    }

    const valid: boolean = await crypto.subtle.verify("Ed25519", publicKey, fromBase64Url(signature.sig), signingBytes({ ...rest, digest }));
    if (!valid) {
        reasons.push("signature does not verify");
    }

    return { ok: reasons.length === 0, reasons };
};

/**
 * Key distribution + revocation. Revoked keys must not verify anything.
 */
export class KeyRegistry {
    private readonly keys = new Map<string, CryptoKey>();
    private readonly revoked = new Set<string>();

    add(kid: Id, publicKey: CryptoKey): void {
        this.keys.set(kid, publicKey);
    }

    revoke(kid: Id): void {
        this.revoked.add(kid);
    }

    get(kid: Id): CryptoKey | undefined {
        return this.revoked.has(kid) ? undefined : this.keys.get(kid);
    }
}

export const verifyWithRegistry: VerifyWithRegistryFn = async (manifest: Manifest, registry: KeyRegistry): Promise<VerifyResult> => {
    const signature: Signature | undefined = manifest.signatures.find((entry) => entry.role === "self");
    if (!signature) {
        return { ok: false, reasons: ["missing self signature"] };
    }
    const key: CryptoKey | undefined = registry.get(signature.kid);
    if (!key) {
        return { ok: false, reasons: [`unknown or revoked key: ${signature.kid}`] };
    }
    return verifyManifest(manifest, key);
};
