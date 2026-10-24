import type { AgentCard } from './agent-card.ts'
import { canonical } from './canonical.ts'
import type { KeyRegistry } from './sign.ts'

/** JWS JSON serialization, EdDSA over the JCS-canonicalised card. */
export interface CardSignature {
  protected: string
  signature: string
}

const encoder = new TextEncoder()

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

function payloadOf(card: AgentCard): BufferSource {
  const { ...rest } = card as AgentCard & { signatures?: unknown }
  delete (rest as { signatures?: unknown }).signatures
  return encoder.encode(canonical(rest)) as unknown as BufferSource
}

function signingInput(protectedHeader: string, payload: BufferSource): BufferSource {
  const encoded = toBase64Url(payload as ArrayBuffer)
  return encoder.encode(`${protectedHeader}.${encoded}`) as unknown as BufferSource
}

export async function signCard(
  card: AgentCard,
  key: { kid: string; privateKey: CryptoKey },
): Promise<CardSignature> {
  const protectedHeader = toBase64Url(
    encoder.encode(JSON.stringify({ alg: 'EdDSA', kid: key.kid })) as unknown as ArrayBuffer,
  )
  const payload = payloadOf(card)
  const signature = await crypto.subtle.sign(
    'Ed25519',
    key.privateKey,
    signingInput(protectedHeader, payload),
  )
  return { protected: protectedHeader, signature: toBase64Url(signature) }
}

export async function verifyCardSignature(
  card: AgentCard,
  signature: CardSignature,
  publicKey: CryptoKey,
): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = []
  let header: { alg?: string; kid?: string }
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(signature.protected) as unknown as ArrayBuffer))
  } catch {
    return { ok: false, reasons: ['protected header is not base64url JSON'] }
  }
  if (header.alg !== 'EdDSA') reasons.push(`unsupported alg ${String(header.alg)}`)

  const valid = await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    fromBase64Url(signature.signature),
    signingInput(signature.protected, payloadOf(card)),
  )
  if (!valid) reasons.push('card signature does not verify')
  return { ok: reasons.length === 0, reasons }
}

/**
 * Resolves the signing key from a trust registry (which Federation bundles can
 * populate) instead of trusting a key embedded in the card itself.
 */
export async function verifyCardWithRegistry(
  card: AgentCard,
  signature: CardSignature,
  registry: KeyRegistry,
): Promise<{ ok: boolean; reasons: string[] }> {
  let header: { kid?: string }
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(signature.protected) as unknown as ArrayBuffer))
  } catch {
    return { ok: false, reasons: ['protected header is not base64url JSON'] }
  }
  if (!header.kid) return { ok: false, reasons: ['signature carries no kid'] }
  const key = registry.get(header.kid)
  if (!key) return { ok: false, reasons: [`unknown or revoked key: ${header.kid}`] }
  return verifyCardSignature(card, signature, key)
}
