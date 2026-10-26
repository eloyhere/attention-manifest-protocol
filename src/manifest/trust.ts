import type { AgentCard } from './agentCard.ts'
import { fetchAgentCard } from './agentCard.ts'
import type { CardSignature } from './cardSign.ts'
import { verifyCardWithRegistry } from './cardSign.ts'
import { registryFromBundle } from './federation.ts'
import { verifyAttestationWithKey } from './federation.ts'
import type { ManifestBundle } from './federationTypes.ts'
import type { Timestamp } from '../types/common.ts'
import type { KeyRegistry } from './sign.ts'

export interface TrustPolicy {
  /** Scopes an attestation must carry before the card is usable. */
  requiredScopes: string[]
}

export interface TrustResult {
  ok: boolean
  reasons: string[]
  scopes: string[]
  endpoint?: string
}

/**
 * The policy gate: keys come from the bundle, endorsement comes from
 * attestations bound to the manifest digest, and required scopes must be
 * signed by an issuer key the caller already trusts.
 */
export async function trustCard(input: {
  card: AgentCard
  signature: CardSignature
  bundle: ManifestBundle
  policy: TrustPolicy
  issuerKeys?: KeyRegistry
  /** Verification time. Defaults to the real clock. */
  now?: Timestamp
}): Promise<TrustResult> {
  const reasons: string[] = []
  const registry = await registryFromBundle(input.bundle)
  const cardVerdict = await verifyCardWithRegistry(input.card, input.signature, registry)
  reasons.push(...cardVerdict.reasons)
  const now = Date.parse(input.now ?? new Date().toISOString())
  if (!Number.isFinite(now)) reasons.push('now is not a valid timestamp')
  const skew = 5 * 60_000

  const scopes = new Set<string>()
  for (const attestation of input.bundle.attestations ?? []) {
    if (attestation.subject.digest !== input.bundle.manifest.digest) {
      reasons.push(`attestation ${attestation.id} does not bind the manifest digest`)
      continue
    }
    const expires = Date.parse(attestation.expires)
    const issued = Date.parse(attestation.issued)
    if (!Number.isFinite(expires) || !Number.isFinite(issued)) {
      reasons.push(`attestation ${attestation.id}: invalid validity window`)
      continue
    }
    if (expires + skew < now) {
      reasons.push(`attestation ${attestation.id}: expired`)
      continue
    }
    if (issued - skew > now) {
      reasons.push(`attestation ${attestation.id}: issued in the future`)
      continue
    }
    const kid = attestation.signatures[0]?.kid
    const issuerKey = kid ? input.issuerKeys?.get(kid) : undefined
    if (!issuerKey) {
      reasons.push(`attestation ${attestation.id}: unknown issuer key ${String(kid)}`)
      continue
    }
    const verdict = await verifyAttestationWithKey(attestation, issuerKey)
    if (!verdict.ok) {
      reasons.push(...verdict.reasons.map((reason) => `${attestation.id}: ${reason}`))
      continue
    }
    for (const scope of attestation.scope) scopes.add(scope)
  }

  for (const required of input.policy.requiredScopes) {
    if (!scopes.has(required)) reasons.push(`missing required scope: ${required}`)
  }

  return { ok: reasons.length === 0, reasons, scopes: [...scopes] }
}

/** Discovery + trust in one call: fetch the card, then apply the policy. */
export async function fetchTrustedAgent(
  baseUrl: string,
  options: {
    bundle: ManifestBundle
    policy: TrustPolicy
    issuerKeys?: KeyRegistry
    timeoutMs?: number
    /** Verification time. Defaults to the real clock. */
    now?: Timestamp
  },
): Promise<TrustResult & { card?: AgentCard }> {
  const discovered = await fetchAgentCard(baseUrl, { timeoutMs: options.timeoutMs })
  if (!discovered.ok || !discovered.card) {
    return { ok: false, reasons: discovered.reasons, scopes: [] }
  }
  const signatures = (discovered.card as AgentCard & { signatures?: CardSignature[] }).signatures
  if (!signatures?.length) {
    return { ok: false, reasons: ['card carries no signature'], scopes: [], card: discovered.card }
  }
  const verdict = await trustCard({
    card: discovered.card,
    signature: signatures[0],
    bundle: options.bundle,
    policy: options.policy,
    issuerKeys: options.issuerKeys,
    now: options.now,
  })
  return { ...verdict, endpoint: discovered.endpoint, card: discovered.card }
}
