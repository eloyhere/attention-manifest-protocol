import type { Digest, Timestamp } from '../types/common.ts'
import type { LedgerSnapshot } from './persistence.ts'
import { verifySnapshot } from './persistence.ts'
import type { KeyPair } from '../manifest/sign.ts'
import { canonical, digestOf } from '../semantic/canonical.ts'

const encoder = new TextEncoder()

/**
 * Domain separator mixed into every checkpoint signature. It keeps an Ed25519
 * signature over a checkpoint body from being replayed as a signature over any
 * other AMP object that happens to contain the same fields.
 */
export const CHECKPOINT_DOMAIN = 'amp:ledger-checkpoint:0.1'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * A signed commitment to the tip of an append-only ledger.
 *
 * The signature covers every field except `sig`. `prev` is the
 * {@link checkpointDigest} of the previous checkpoint — the digest of that
 * checkpoint's canonical signed body, not a ledger entry hash. It makes the
 * sequence of checkpoints a chain of its own, independent of the entry chain it
 * witnesses.
 */
export interface LedgerCheckpoint {
  amp: '0.1'
  kind: 'ledger-checkpoint'
  tenant: string
  agent: string
  /** Position in the checkpoint chain; `0` for the first, then one more each time. */
  seq: number
  /** Number of entries in the snapshot at `tip`. */
  count: number
  /** Entry hash at the tip of the witnessed chain. */
  tip: Digest
  /** Digest of the previous checkpoint's signed body, or absent for the first. */
  prev?: Digest
  issued: Timestamp
  kid: string
  /** base64url Ed25519 signature over the domain-separated canonical body. */
  sig: string
}

/** Inputs for {@link sealCheckpoint}. */
export interface CheckpointOptions {
  tenant: string
  /** Defaults to `new Date().toISOString()`. */
  issued?: Timestamp
  /** The checkpoint this one extends; its `seq` and digest are committed to. */
  previous?: LedgerCheckpoint
}

/** Fail-closed verification result. */
export interface CheckpointVerdict {
  ok: boolean
  reasons: string[]
}

type CheckpointBody = Omit<LedgerCheckpoint, 'sig'>

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

/**
 * Selects exactly the signed fields, dropping `sig` and any runtime extras.
 * Conditional inclusion keeps `prev` absent (rather than `null`) on the first
 * checkpoint, so its canonical form is stable across implementations.
 */
function checkpointFields(checkpoint: CheckpointBody): CheckpointBody {
  const fields: CheckpointBody = {
    amp: checkpoint.amp,
    kind: checkpoint.kind,
    tenant: checkpoint.tenant,
    agent: checkpoint.agent,
    seq: checkpoint.seq,
    count: checkpoint.count,
    tip: checkpoint.tip,
    issued: checkpoint.issued,
    kid: checkpoint.kid,
  }
  if (checkpoint.prev !== undefined) fields.prev = checkpoint.prev
  return fields
}

/**
 * Canonical JSON of the checkpoint body: every signed field, `sig` excluded,
 * keys sorted by {@link canonical}. This is the part of the signing input that
 * other implementations must reproduce exactly.
 *
 * The signature itself is over `CHECKPOINT_DOMAIN + '\n' + checkpointBody(...)`
 * so a valid checkpoint signature cannot be moved to another object kind.
 */
export function checkpointBody(checkpoint: CheckpointBody): string {
  return canonical(checkpointFields(checkpoint))
}

/**
 * Digest of the signed checkpoint body (everything except `sig`).
 *
 * Used as the `prev` link between checkpoints and safe to log or index. It is
 * not a ledger entry hash and must not be compared with `snapshot.tip`.
 */
export function checkpointDigest(checkpoint: LedgerCheckpoint): Digest {
  return digestOf(checkpointFields(checkpoint))
}

function signingBytes(body: string): BufferSource {
  return encoder.encode(`${CHECKPOINT_DOMAIN}\n${body}`) as unknown as BufferSource
}

/**
 * Signs the snapshot's chain tip as a new checkpoint.
 *
 * `seq` is `(previous?.seq ?? -1) + 1`, and `prev` — when a previous checkpoint
 * is supplied — is `checkpointDigest(previous)`. The seal does not verify the
 * snapshot first: callers should pass a snapshot that has already been checked
 * (as {@link AppendLog.seal} does). The signature is Ed25519 over the
 * domain-separated canonical body, never over JavaScript property order.
 */
export async function sealCheckpoint(
  snapshot: LedgerSnapshot,
  key: KeyPair,
  options: CheckpointOptions,
): Promise<LedgerCheckpoint> {
  const previous = options.previous
  const body: CheckpointBody = {
    amp: '0.1',
    kind: 'ledger-checkpoint',
    tenant: options.tenant,
    agent: snapshot.agent,
    seq: (previous?.seq ?? -1) + 1,
    count: snapshot.count,
    tip: snapshot.tip,
    issued: options.issued ?? new Date().toISOString(),
    kid: key.kid,
  }
  if (previous !== undefined) body.prev = checkpointDigest(previous)

  const signature = await crypto.subtle.sign(
    'Ed25519',
    key.privateKey,
    signingBytes(checkpointBody(body)),
  )
  return { ...body, sig: toBase64Url(signature) }
}

function isEmpty(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0
}

/**
 * Verifies a checkpoint without trusting any field in it.
 *
 * Checks the envelope (`amp`/`kind`), non-empty tenant/agent/kid/issued,
 * non-negative integer `seq`/`count`, `sha256:<64 hex>` tip and (when present)
 * prev format, then recomputes the canonical body and verifies the Ed25519
 * signature. If `previous` is supplied, the checkpoint must be linked to it:
 * `seq` must be exactly `previous.seq + 1`, `prev` must equal
 * `checkpointDigest(previous)`, and tenant/agent must stay constant. The
 * previous checkpoint's own signature is the caller's responsibility.
 */
export async function verifyCheckpoint(
  checkpoint: LedgerCheckpoint,
  publicKey: CryptoKey,
  previous?: LedgerCheckpoint,
): Promise<CheckpointVerdict> {
  const reasons: string[] = []

  if (!checkpoint || typeof checkpoint !== 'object') {
    return { ok: false, reasons: ['checkpoint is not an object'] }
  }
  if (checkpoint.amp !== '0.1') reasons.push('unsupported checkpoint amp version')
  if (checkpoint.kind !== 'ledger-checkpoint') reasons.push('not a ledger checkpoint')
  if (isEmpty(checkpoint.tenant)) reasons.push('tenant is empty')
  if (isEmpty(checkpoint.agent)) reasons.push('agent is empty')
  if (isEmpty(checkpoint.kid)) reasons.push('kid is empty')
  if (isEmpty(checkpoint.issued)) reasons.push('issued is empty')
  if (!Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 0) {
    reasons.push('seq is not a non-negative integer')
  }
  if (!Number.isSafeInteger(checkpoint.count) || checkpoint.count < 0) {
    reasons.push('count is not a non-negative integer')
  }
  if (typeof checkpoint.tip !== 'string' || !DIGEST_PATTERN.test(checkpoint.tip)) {
    reasons.push('tip is not a sha256 digest')
  }
  if (
    checkpoint.prev !== undefined &&
    (typeof checkpoint.prev !== 'string' || !DIGEST_PATTERN.test(checkpoint.prev))
  ) {
    reasons.push('prev is not a sha256 digest')
  }

  if (previous !== undefined) {
    if (!Number.isSafeInteger(previous.seq) || previous.seq < 0) {
      reasons.push('previous checkpoint seq is not a non-negative integer')
    } else if (checkpoint.seq !== previous.seq + 1) {
      reasons.push(`seq ${checkpoint.seq} does not continue from ${previous.seq}`)
    }
    if (checkpoint.agent !== previous.agent) reasons.push('agent does not match the previous checkpoint')
    if (checkpoint.tenant !== previous.tenant) reasons.push('tenant does not match the previous checkpoint')

    if (checkpoint.prev === undefined) {
      reasons.push('missing prev link to the previous checkpoint')
    } else {
      try {
        if (checkpoint.prev !== checkpointDigest(previous)) {
          reasons.push('prev does not match the previous checkpoint digest')
        }
      } catch {
        reasons.push('previous checkpoint cannot be canonicalized')
      }
    }
  }

  let body: string | undefined
  try {
    body = checkpointBody(checkpoint)
  } catch {
    reasons.push('checkpoint body cannot be canonicalized')
  }

  if (isEmpty(checkpoint.sig)) {
    reasons.push('signature is empty')
  } else if (!SIGNATURE_PATTERN.test(checkpoint.sig)) {
    reasons.push('signature is not base64url')
  } else if (body !== undefined) {
    try {
      const valid = await crypto.subtle.verify(
        'Ed25519',
        publicKey,
        fromBase64Url(checkpoint.sig),
        signingBytes(body),
      )
      if (!valid) reasons.push('signature does not verify')
    } catch {
      reasons.push('signature does not verify')
    }
  }

  return { ok: reasons.length === 0, reasons }
}

/**
 * Checks that a snapshot is the exact chain a checkpoint signed.
 *
 * First compares agent/count/tip with the checkpoint, then runs
 * {@link verifySnapshot} so a rewritten middle entry cannot hide behind a
 * matching tip declaration. This does not verify the checkpoint signature;
 * combine it with {@link verifyCheckpoint} for end-to-end assurance.
 */
export async function verifySnapshotAgainstCheckpoint(
  snapshot: LedgerSnapshot,
  checkpoint: LedgerCheckpoint,
): Promise<CheckpointVerdict> {
  const reasons: string[] = []

  if (snapshot.agent !== checkpoint.agent) {
    reasons.push(`snapshot agent ${snapshot.agent} does not match checkpoint agent ${checkpoint.agent}`)
  }
  if (snapshot.count !== checkpoint.count) {
    reasons.push(`snapshot count ${snapshot.count} does not match checkpoint count ${checkpoint.count}`)
  }
  if (snapshot.tip !== checkpoint.tip) {
    reasons.push('snapshot tip does not match checkpoint tip')
  }

  const verdict = verifySnapshot(snapshot)
  reasons.push(...verdict.reasons)
  return { ok: reasons.length === 0, reasons }
}
