/**
 * AMP v0.1 — Federation Profile: bundles and third-party attestations.
 * Mirrors docs/schemas/federation.schema.json.
 */
import type { Digest, Id, Ref, Signature, Timestamp } from "../types/common.ts";
import type { Manifest } from "./manifest.ts";

export interface KeyMaterial {
    kid: string;
    alg: "ed25519";
    /**
     * base64url raw public key.
     */
    publicKey: string;
}

/**
 * A bundle is a transport shape, not a new trust root: the manifest inside is
 * already signed, and the keys are the minimum needed to check it.
 */
export interface ManifestBundle {
    amp: "0.1";
    kind: "bundle";
    manifest: Manifest;
    keys: KeyMaterial[];
    /**
     * Keys the issuing domain has revoked; the receiver still merges its own list.
     */
    revoked?: string[];
    issued: Timestamp;
    expires: Timestamp;
    digest: Digest;
    attestations?: Attestation[];
}

export interface AttestationSubject {
    kind: "manifest";
    id: Id;
    /**
     * Bound to bytes, not to a name or version.
     */
    digest: Digest;
}

export interface Attestation {
    amp: "0.1";
    kind: "attestation";
    id: Id;
    issuer: Ref;
    subject: AttestationSubject;
    scope: string[];
    issued: Timestamp;
    expires: Timestamp;
    signatures: Signature[];
}
