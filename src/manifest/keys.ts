/**
 * AMP v0.1 — key lifecycle: validity windows, rotation, retirement and
 * revocation.
 *
 * This layer is deliberately independent of the envelope and federation
 * formats. It stores public keys and lifecycle metadata only; it never signs
 * or verifies a revocation list. A caller must authenticate a list's
 * `issuer` signature against its own trust root before merging it or acting
 * on its entries.
 */
import type { Id, Timestamp } from '../types/common.ts'
import type { Manifest } from './manifest.ts'

/** Default tolerance for issuer/verifier clock disagreement (five minutes). */
const DEFAULT_CLOCK_SKEW_MS = 5 * 60_000

/** Lifecycle state: active keys are current, retired keys only verify history. */
export type KeyStatus = 'active' | 'retired' | 'revoked'

/** A public key plus the lifecycle metadata needed to judge it at a time. */
export interface KeyRecord {
  kid: Id
  publicKey: CryptoKey
  status: KeyStatus
  validFrom: Timestamp
  validTo?: Timestamp
  /** Kid this key replaced, when it was introduced by a rotation. */
  supersedes?: Id
  /** Free-form audit note; this module never interprets it. */
  note?: string
}

/** One kid revoked by an issuer, at a time and for an optional reason. */
export interface RevocationEntry {
  kid: Id
  revokedAt: Timestamp
  reason?: string
}

/**
 * A signed-by-the-caller revocation snapshot. This module only compares and
 * merges the data; it does not verify the `issuer` signature.
 */
export interface RevocationList {
  issuer: string
  issued: Timestamp
  nextUpdate: Timestamp
  revoked: RevocationEntry[]
}

/** Optional clock and skew policy for a `Keyring`. */
export interface KeyringOptions {
  /** Clock used when an operation is not given an explicit timestamp. */
  now?: () => Timestamp
  /**
   * Symmetric tolerance around validity windows, in milliseconds. Defaults
   * to 0 so a key is only usable inside the window its issuer declared.
   */
  clockSkewMs?: number
}

/** Epoch milliseconds for a finite timestamp, or `undefined` when malformed. */
function instantOf(value: Timestamp): number | undefined {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Epoch milliseconds, or a range error naming the invalid field. */
function requireInstant(value: Timestamp, field: string): number {
  const parsed = instantOf(value)
  if (parsed === undefined) throw new RangeError(`${field} is not a valid timestamp: ${value}`)
  return parsed
}

function timestampOf(ms: number): Timestamp {
  if (!Number.isFinite(ms)) throw new RangeError('timestamp is not finite')
  return new Date(ms).toISOString()
}

function validateWindow(record: KeyRecord): void {
  const from = requireInstant(record.validFrom, 'validFrom')
  if (record.validTo === undefined) return
  const to = requireInstant(record.validTo, 'validTo')
  if (to <= from) throw new RangeError('validTo must be after validFrom')
}

function copyRecord(record: KeyRecord): KeyRecord {
  return { ...record }
}

/** Canonical entry shape, so merge output does not inherit input key order. */
function copyRevocation(entry: RevocationEntry): RevocationEntry {
  return {
    kid: entry.kid,
    revokedAt: entry.revokedAt,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  }
}

function compareIds(left: Id, right: Id): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * In-memory public-key lifecycle store.
 *
 * A record is usable while its status is `active` or `retired` and `at` lies
 * inside its validity window. Revocation is permanent and wins over every
 * window: a historical timestamp cannot resurrect a revoked key. Retired
 * records are retained so signatures made before rotation stay verifiable.
 */
export class Keyring {
  private readonly records = new Map<Id, KeyRecord>()
  private readonly revocationByKid = new Map<Id, RevocationEntry>()
  private readonly clock: () => Timestamp
  private readonly clockSkewMs: number

  constructor(options: KeyringOptions = {}) {
    this.clock = options.now ?? (() => new Date().toISOString())
    const clockSkewMs = options.clockSkewMs ?? 0
    if (!Number.isFinite(clockSkewMs) || clockSkewMs < 0) {
      throw new RangeError('clockSkewMs must be a non-negative finite number')
    }
    this.clockSkewMs = clockSkewMs
  }

  /**
   * Adds a key record. Throws on a duplicate kid, a malformed timestamp, or
   * a window whose `validTo` is not strictly after `validFrom`.
   *
   * A record supplied already `revoked` is registered as revoked at its
   * `validFrom` (using the note as the reason), so it is never usable. Use
   * `revoke()` to record a later revocation time.
   */
  add(record: KeyRecord): void {
    if (this.records.has(record.kid)) throw new Error(`duplicate kid: ${record.kid}`)
    validateWindow(record)
    const stored = copyRecord(record)
    this.records.set(stored.kid, stored)
    if (stored.status === 'revoked') {
      this.revocationByKid.set(stored.kid, {
        kid: stored.kid,
        revokedAt: stored.validFrom,
        ...(stored.note === undefined ? {} : { reason: stored.note }),
      })
    }
  }

  /**
   * Rotates from `currentKid` to `next`.
   *
   * The current record becomes `retired` and remains available for historical
   * timestamps. It stops being usable after the overlap, which ends at
   * `now + overlapMs` (or at `now` when omitted), capped by the current key's
   * existing `validTo` so rotation never extends a lifetime the issuer
   * already bounded. The successor starts at `next.validFrom` (default now)
   * and records `supersedes: currentKid`.
   *
   * Throws for an unknown, retired or revoked current key, a duplicate next
   * kid, or a negative/non-finite overlap.
   */
  rotate(
    currentKid: Id,
    next: { kid: Id; publicKey: CryptoKey; validFrom?: Timestamp; overlapMs?: number },
  ): KeyRecord {
    const current = this.records.get(currentKid)
    if (!current) throw new Error(`unknown key: ${currentKid}`)
    if (current.status === 'revoked') throw new Error(`cannot rotate a revoked key: ${currentKid}`)
    if (current.status !== 'active') throw new Error(`cannot rotate a retired key: ${currentKid}`)
    if (this.records.has(next.kid)) throw new Error(`duplicate kid: ${next.kid}`)

    const overlapMs = next.overlapMs ?? 0
    if (!Number.isFinite(overlapMs) || overlapMs < 0) {
      throw new RangeError('overlapMs must be a non-negative finite number')
    }

    const now = this.clock()
    const nowMs = requireInstant(now, 'now')
    const nextValidFrom = next.validFrom ?? now
    requireInstant(nextValidFrom, 'validFrom')

    const currentFromMs = requireInstant(current.validFrom, 'validFrom')
    const currentValidTo = current.validTo
    const currentToMs =
      currentValidTo === undefined ? undefined : requireInstant(currentValidTo, 'validTo')
    const plannedEndMs = nowMs + overlapMs
    const endMs = currentToMs === undefined ? plannedEndMs : Math.min(plannedEndMs, currentToMs)
    if (endMs <= currentFromMs) {
      throw new RangeError('overlap ends before the current key becomes valid')
    }

    let end: Timestamp
    if (currentValidTo !== undefined && currentToMs !== undefined && endMs === currentToMs) {
      end = currentValidTo
    } else if (overlapMs === 0) {
      end = now
    } else {
      end = timestampOf(plannedEndMs)
    }

    current.status = 'retired'
    current.validTo = end

    const successor: KeyRecord = {
      kid: next.kid,
      publicKey: next.publicKey,
      status: 'active',
      validFrom: nextValidFrom,
      supersedes: currentKid,
    }
    this.records.set(successor.kid, successor)
    return copyRecord(successor)
  }

  /**
   * Revokes a key permanently, returning `false` when the kid is unknown or
   * was already revoked. The record is kept for audit, and the revocation
   * takes precedence over every validity window and overlap.
   */
  revoke(kid: Id, at?: Timestamp, reason?: string): boolean {
    const record = this.records.get(kid)
    if (!record || record.status === 'revoked') return false
    const revokedAt = at ?? this.clock()
    requireInstant(revokedAt, 'at')
    record.status = 'revoked'
    this.revocationByKid.set(kid, {
      kid,
      revokedAt,
      ...(reason === undefined ? {} : { reason }),
    })
    return true
  }

  /**
   * Retires an active key at `at` (default now), returning `false` when the
   * key is unknown, already retired or revoked. The key remains usable for
   * timestamps before `at` but not after it. Retirement never extends an
   * existing `validTo`.
   */
  retire(kid: Id, at?: Timestamp): boolean {
    const record = this.records.get(kid)
    if (!record || record.status !== 'active') return false
    const retiredAt = at ?? this.clock()
    const retiredAtMs = requireInstant(retiredAt, 'at')
    const fromMs = requireInstant(record.validFrom, 'validFrom')
    if (retiredAtMs <= fromMs) {
      throw new RangeError('retirement must be after validFrom')
    }
    const currentToMs =
      record.validTo === undefined ? undefined : requireInstant(record.validTo, 'validTo')
    if (currentToMs === undefined || retiredAtMs < currentToMs) record.validTo = retiredAt
    record.status = 'retired'
    return true
  }

  /**
   * Returns the public key usable at `at` (default now). Revoked keys always
   * return `undefined`; active and retired keys return `undefined` outside
   * their validity window. A non-zero `clockSkewMs` widens both edges.
   */
  get(kid: Id, at?: Timestamp): CryptoKey | undefined {
    const record = this.records.get(kid)
    if (!record || record.status === 'revoked') return undefined
    const atMs = requireInstant(at ?? this.clock(), 'at')
    return this.contains(record, atMs) ? record.publicKey : undefined
  }

  /** Returns a copy of the lifecycle record, including retired/revoked history. */
  record(kid: Id): KeyRecord | undefined {
    const found = this.records.get(kid)
    return found ? copyRecord(found) : undefined
  }

  /** Lists active (not retired or revoked) records usable at `at` (default now). */
  active(at?: Timestamp): KeyRecord[] {
    const atMs = requireInstant(at ?? this.clock(), 'at')
    const result: KeyRecord[] = []
    for (const record of this.records.values()) {
      if (record.status === 'active' && this.contains(record, atMs)) result.push(copyRecord(record))
    }
    return result
  }

  /** True when the kid was revoked; unknown kids are not revoked. */
  isRevoked(kid: Id): boolean {
    return this.records.get(kid)?.status === 'revoked'
  }

  /**
   * Explains whether `at` is inside the key's usable window. Missing,
   * revoked, not-yet-valid and expired keys produce `ok: false` with reasons.
   */
  verifyWindow(kid: Id, at: Timestamp): { ok: boolean; reasons: string[] } {
    const record = this.records.get(kid)
    if (!record) return { ok: false, reasons: [`missing key: ${kid}`] }
    const atMs = requireInstant(at, 'at')
    const reasons: string[] = []
    if (record.status === 'revoked') reasons.push(`key is revoked: ${kid}`)
    const fromMs = requireInstant(record.validFrom, 'validFrom')
    if (atMs < fromMs - this.clockSkewMs) reasons.push(`key is not yet valid: ${kid}`)
    if (record.validTo !== undefined) {
      const toMs = requireInstant(record.validTo, 'validTo')
      if (atMs > toMs + this.clockSkewMs) reasons.push(`key expired: ${kid}`)
    }
    return { ok: reasons.length === 0, reasons }
  }

  /**
   * Revocations in deterministic order (earliest first, then kid). Entries
   * are copies; mutating the result does not change the keyring.
   */
  revocations(): ReadonlyArray<RevocationEntry> {
    const entries = [...this.revocationByKid.values()].map(copyRevocation)
    entries.sort((left, right) => {
      const byTime =
        requireInstant(left.revokedAt, 'revokedAt') - requireInstant(right.revokedAt, 'revokedAt')
      return byTime !== 0 ? byTime : compareIds(left.kid, right.kid)
    })
    return entries
  }

  private contains(record: KeyRecord, atMs: number): boolean {
    const fromMs = requireInstant(record.validFrom, 'validFrom')
    if (atMs < fromMs - this.clockSkewMs) return false
    if (record.validTo === undefined) return true
    const toMs = requireInstant(record.validTo, 'validTo')
    return atMs <= toMs + this.clockSkewMs
  }
}

/** Thrown by `requireFresh()` when a revocation list cannot be trusted as current. */
export class RevocationError extends Error {
  /** Machine-readable reasons the list was rejected. */
  readonly reasons: string[]

  constructor(message: string, reasons: string[] = []) {
    super(message)
    this.name = 'RevocationError'
    this.reasons = reasons
  }
}

function revocationFreshnessProblems(
  list: RevocationList,
  now: Timestamp,
  maxStalenessMs: number,
): string[] {
  const problems: string[] = []
  if (!Number.isFinite(maxStalenessMs) || maxStalenessMs < 0) {
    problems.push('maxStalenessMs must be a non-negative finite number')
  }

  const nowMs = instantOf(now)
  if (nowMs === undefined) problems.push('now is not a valid timestamp')
  const issuedMs = instantOf(list.issued)
  if (issuedMs === undefined) problems.push('issued is not a valid timestamp')
  const nextUpdateMs = instantOf(list.nextUpdate)
  if (nextUpdateMs === undefined) problems.push('nextUpdate is not a valid timestamp')

  if (issuedMs !== undefined && nextUpdateMs !== undefined && nextUpdateMs < issuedMs) {
    problems.push('nextUpdate precedes issued')
  }
  if (issuedMs !== undefined && nowMs !== undefined && issuedMs > nowMs) {
    problems.push('issued is in the future')
  }
  if (
    nextUpdateMs !== undefined &&
    nowMs !== undefined &&
    Number.isFinite(maxStalenessMs) &&
    maxStalenessMs >= 0 &&
    nowMs > nextUpdateMs + maxStalenessMs
  ) {
    problems.push('revocation list is stale')
  }
  if (!Array.isArray(list.revoked)) {
    problems.push('revoked is not an array')
  } else {
    for (const entry of list.revoked) {
      if (instantOf(entry.revokedAt) === undefined) {
        problems.push(`revokedAt for ${entry.kid} is not a valid timestamp`)
      }
    }
  }
  return problems
}

/**
 * Freshness verdict for a revocation list.
 *
 * Returns `false` for malformed top-level or entry timestamps, a list whose
 * `nextUpdate` precedes `issued`, an `issued` timestamp in the future, or a
 * list older than `nextUpdate + maxStalenessMs`. There is no skew parameter:
 * a verifier should pass a clock reading it is willing to defend.
 */
export function isRevocationFresh(
  list: RevocationList,
  now: Timestamp,
  maxStalenessMs: number,
): boolean {
  return revocationFreshnessProblems(list, now, maxStalenessMs).length === 0
}

/** Returns `list` when fresh; otherwise throws a `RevocationError` with reasons. */
export function requireFresh(
  list: RevocationList,
  now: Timestamp,
  maxStalenessMs: number,
): RevocationList {
  const problems = revocationFreshnessProblems(list, now, maxStalenessMs)
  if (problems.length > 0) {
    throw new RevocationError(`unfresh revocation list: ${problems.join('; ')}`, problems)
  }
  return list
}

/**
 * Checks a manifest's own validity window. `issued` may be up to `skewMs`
 * ahead of `now`, and `expires` up to `skewMs` behind it; the default
 * tolerance is five minutes, matching federation import. Malformed dates and
 * `expires <= issued` are rejected.
 */
export function checkManifestWindow(
  manifest: Pick<Manifest, 'issued' | 'expires'>,
  now: Timestamp,
  skewMs: number = DEFAULT_CLOCK_SKEW_MS,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!Number.isFinite(skewMs) || skewMs < 0) {
    reasons.push('skewMs must be a non-negative finite number')
  }

  const nowMs = instantOf(now)
  if (nowMs === undefined) reasons.push('now is not a valid timestamp')
  const issuedMs = instantOf(manifest.issued)
  if (issuedMs === undefined) reasons.push('manifest issued is not a valid timestamp')
  const expiresMs = instantOf(manifest.expires)
  if (expiresMs === undefined) reasons.push('manifest expires is not a valid timestamp')

  if (issuedMs !== undefined && expiresMs !== undefined && expiresMs <= issuedMs) {
    reasons.push('manifest expires must be after issued')
  }
  if (Number.isFinite(skewMs) && skewMs >= 0) {
    if (nowMs !== undefined && expiresMs !== undefined && nowMs > expiresMs + skewMs) {
      reasons.push('manifest expired')
    }
    if (nowMs !== undefined && issuedMs !== undefined && issuedMs - skewMs > nowMs) {
      reasons.push('manifest issued in the future')
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/** Latest timestamp; ties normalize to the lexicographically smaller spelling. */
function latestTimestamp(left: Timestamp, right: Timestamp, field: string): Timestamp {
  const leftMs = requireInstant(left, field)
  const rightMs = requireInstant(right, field)
  if (leftMs > rightMs) return left
  if (rightMs > leftMs) return right
  return left <= right ? left : right
}

/** Earliest revocation; ties use a canonical spelling/reason so order is stable. */
function earlierRevocation(left: RevocationEntry, right: RevocationEntry): RevocationEntry {
  const leftMs = requireInstant(left.revokedAt, 'revokedAt')
  const rightMs = requireInstant(right.revokedAt, 'revokedAt')
  if (leftMs < rightMs) return left
  if (rightMs < leftMs) return right
  if (left.revokedAt !== right.revokedAt) {
    return left.revokedAt < right.revokedAt ? left : right
  }
  if (left.reason === undefined && right.reason !== undefined) return right
  if (right.reason === undefined && left.reason !== undefined) return left
  const leftReason = left.reason ?? ''
  const rightReason = right.reason ?? ''
  if (leftReason !== rightReason) return leftReason < rightReason ? left : right
  return left
}

/**
 * Merges two authenticated revocation lists from the same issuer.
 *
 * The union keeps the earliest `revokedAt` per kid, chooses the latest
 * `issued` and `nextUpdate`, and sorts by `revokedAt` then kid, so the result
 * does not depend on argument order or on repeated merges. Different issuers
 * throw: a single list must answer to one signature.
 *
 * This function performs no signature verification. Authenticate both lists
 * (and their issuer) first; never merge untrusted snapshots.
 */
export function mergeRevocations(local: RevocationList, remote: RevocationList): RevocationList {
  if (local.issuer !== remote.issuer) {
    throw new Error(
      `cannot merge revocation lists from different issuers: ${local.issuer} and ${remote.issuer}`,
    )
  }

  const merged = new Map<Id, RevocationEntry>()
  for (const entry of [...local.revoked, ...remote.revoked]) {
    requireInstant(entry.revokedAt, 'revokedAt')
    const existing = merged.get(entry.kid)
    merged.set(entry.kid, existing ? earlierRevocation(existing, entry) : copyRevocation(entry))
  }

  const revoked = [...merged.values()]
    .map(copyRevocation)
    .sort((left, right) => {
      const byTime =
        requireInstant(left.revokedAt, 'revokedAt') - requireInstant(right.revokedAt, 'revokedAt')
      return byTime !== 0 ? byTime : compareIds(left.kid, right.kid)
    })

  return {
    issuer: local.issuer,
    issued: latestTimestamp(local.issued, remote.issued, 'issued'),
    nextUpdate: latestTimestamp(local.nextUpdate, remote.nextUpdate, 'nextUpdate'),
    revoked,
  }
}
