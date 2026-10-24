import type { Digest, Id, Ref, Timestamp } from '../types/common.ts'
import type { Attestation, KeyMaterial, ManifestBundle } from '../types/federation.ts'
import type { Manifest } from '../types/manifest.ts'
import { canonical, digestOf } from './canonical.ts'
import { KeyRegistry } from './sign.ts'
import type { KeyPair } from './sign.ts'
import { verifyManifest } from './sign.ts'

const encoder = new TextEncoder()
const SKEW_MS = 5 * 60_000

function toBase64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): BufferSource {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : ''
  const binary = atob(padded + pad)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)) as unknown as BufferSource
}

async function exportKeyMaterial(key: KeyPair): Promise<KeyMaterial> {
  const raw = await crypto.subtle.exportKey('raw', key.publicKey)
  return { kid: key.kid, alg: 'ed25519', publicKey: toBase64Url(raw) }
}

async function importPublicKey(material: KeyMaterial): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64Url(material.publicKey), { name: 'Ed25519' }, true, [
    'verify',
  ])
}

/* ------------------------------- bundle ------------------------------- */

/** Digest covers manifest + keys + revocation + validity window. */
export function bundleDigest(bundle: Omit<ManifestBundle, 'digest' | 'attestations'>): Digest {
  return digestOf({
    manifest: bundle.manifest,
    keys: bundle.keys,
    revoked: bundle.revoked ?? [],
    issued: bundle.issued,
    expires: bundle.expires,
  })
}

export async function exportBundle(
  manifest: Manifest,
  key: KeyPair,
  options: { issued: Timestamp; expires: Timestamp; revoked?: string[]; attestations?: Attestation[] },
): Promise<ManifestBundle> {
  const base = {
    amp: '0.1' as const,
    kind: 'bundle' as const,
    manifest,
    keys: [await exportKeyMaterial(key)],
    revoked: options.revoked ?? [],
    issued: options.issued,
    expires: options.expires,
  }
  return { ...base, digest: bundleDigest(base), attestations: options.attestations }
}

export interface ImportResult {
  ok: boolean
  reasons: string[]
  manifest?: Manifest
  /** True only when an attestation binds to the manifest digest. */
  attested: boolean
  attestations: Id[]
}

/**
 * Fails closed. Every check must pass before the manifest is used;
 * the only permitted degradation is "not endorsed", never "less verified".
 */
export async function importBundle(
  bundle: ManifestBundle,
  options: { now: Timestamp; revoked?: string[] },
): Promise<ImportResult> {
  const reasons: string[] = []
  const { digest, attestations, ...rest } = bundle

  if (bundleDigest(rest) !== digest) {
    reasons.push('bundle digest does not cover its content')
  }

  const now = Date.parse(options.now)
  if (Date.parse(bundle.expires) + SKEW_MS < now) reasons.push('bundle expired')
  if (Date.parse(bundle.issued) - SKEW_MS > now) reasons.push('bundle issued in the future')

  const signature = bundle.manifest.signatures.find((entry) => entry.role === 'self')
  if (!signature) reasons.push('manifest has no self signature')

  const key = signature ? bundle.keys.find((material) => material.kid === signature.kid) : undefined
  if (signature && !key) reasons.push(`missing key for kid ${signature.kid}`)

  const revoked = new Set([...(bundle.revoked ?? []), ...(options.revoked ?? [])])
  if (signature && revoked.has(signature.kid)) reasons.push(`key revoked: ${signature.kid}`)

  if (signature && key) {
    try {
      const publicKey = await importPublicKey(key)
      const verification = await verifyManifest(bundle.manifest, publicKey)
      for (const reason of verification.reasons) reasons.push(reason)
    } catch {
      reasons.push('public key cannot be imported')
    }
  }

  const endorsed = (attestations ?? []).filter(
    (attestation) => attestation.subject.digest === bundle.manifest.digest,
  )

  return {
    ok: reasons.length === 0,
    reasons,
    manifest: reasons.length === 0 ? bundle.manifest : undefined,
    attested: endorsed.length > 0,
    attestations: endorsed.map((attestation) => attestation.id),
  }
}

/** Imports a bundle's keys into a registry; revoked kids stay revoked. */
export async function registryFromBundle(bundle: ManifestBundle): Promise<KeyRegistry> {
  const registry = new KeyRegistry()
  for (const material of bundle.keys) {
    registry.add(material.kid, await importPublicKey(material))
  }
  for (const kid of bundle.revoked ?? []) {
    registry.revoke(kid)
  }
  return registry
}

/* ----------------------------- attestation ---------------------------- */
export async function attest(input: {
  id: Id
  issuer: Ref
  manifest: Manifest
  scope: string[]
  issued: Timestamp
  expires: Timestamp
  key: KeyPair
}): Promise<Attestation> {
  const body = {
    amp: '0.1' as const,
    kind: 'attestation' as const,
    id: input.id,
    issuer: input.issuer,
    subject: {
      kind: 'manifest' as const,
      id: input.manifest.agent.id,
      digest: input.manifest.digest,
    },
    scope: input.scope,
    issued: input.issued,
    expires: input.expires,
  }
  const signature = await crypto.subtle.sign('Ed25519', input.key.privateKey, encoder.encode(canonical(body)))
  return {
    ...body,
    signatures: [
      { role: 'org', alg: 'ed25519', kid: input.key.kid, sig: toBase64Url(signature) },
    ],
  }
}

export async function verifyAttestation(
  attestation: Attestation,
  issuerKey: KeyPair,
): Promise<{ ok: boolean; reasons: string[] }> {
  return verifyAttestationWithKey(attestation, issuerKey.publicKey)
}

/** Public-key variant so a verifier does not need the issuer's private key. */
export async function verifyAttestationWithKey(
  attestation: Attestation,
  publicKey: CryptoKey,
): Promise<{ ok: boolean; reasons: string[] }> {
  const { signatures, ...body } = attestation
  const signature = signatures[0]
  if (!signature) return { ok: false, reasons: ['attestation has no signature'] }
  const valid = await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    fromBase64Url(signature.sig),
    encoder.encode(canonical(body)),
  )
  return { ok: valid, reasons: valid ? [] : ['attestation signature does not verify'] }
}
