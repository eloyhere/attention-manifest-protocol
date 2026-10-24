import type { Ledger } from './ledger.ts'
import { digestOf } from './canonical.ts'

export type EntryKind =
  | 'event'
  | 'frame'
  | 'receipt'
  | 'claim'
  | 'hypothesis'
  | 'unknown'
  | 'goal'
  | 'plan'

export interface ChainEntry {
  seq: number
  kind: EntryKind
  payload: unknown
  prev: string
  hash: string
}

export interface LedgerSnapshot {
  amp: '0.1'
  kind: 'ledger-snapshot'
  agent: string
  tip: string
  count: number
  entries: ChainEntry[]
}

export interface SnapshotVerdict {
  ok: boolean
  reasons: string[]
}

const GENESIS = `sha256:${'0'.repeat(64)}`

const KIND_ORDER: EntryKind[] = [
  'event',
  'frame',
  'claim',
  'hypothesis',
  'unknown',
  'goal',
  'plan',
  'receipt',
]

function hashOf(seq: number, kind: EntryKind, payload: unknown, prev: string): string {
  return digestOf({ seq, kind, payload, prev })
}

function timestampOf(item: Record<string, unknown>): string {
  const candidate = (item.at ?? item.ts ?? item.created ?? item.since) as unknown
  return typeof candidate === 'string' ? candidate : ''
}

/**
 * Snapshot = a single chronological chain over the whole ledger.
 *
 * The chain is what makes "append-only" checkable after the fact: changing,
 * reordering, or dropping any entry breaks every hash after it.
 */
export function exportLedger(ledger: Ledger, agent: string): LedgerSnapshot {
  type Item = { kind: EntryKind; at: string; order: number; payload: unknown }
  const items: Item[] = []

  const add = (kind: EntryKind, list: unknown[]): void => {
    for (const payload of list) {
      const record = payload as Record<string, unknown>
      items.push({ kind, at: timestampOf(record), order: KIND_ORDER.indexOf(kind), payload })
    }
  }

  add('event', ledger.events)
  add('frame', ledger.frames)
  add('claim', ledger.claims)
  add('hypothesis', ledger.hypotheses)
  add('unknown', ledger.unknowns)
  add('goal', ledger.goals)
  add('plan', ledger.plans)
  add('receipt', ledger.receipts)

  items.sort((a, b) => (a.at === b.at ? a.order - b.order : a.at < b.at ? -1 : 1))

  const entries: ChainEntry[] = []
  let prev = GENESIS
  for (const item of items) {
    const seq = entries.length
    const hash = hashOf(seq, item.kind, item.payload, prev)
    entries.push({ seq, kind: item.kind, payload: item.payload, prev, hash })
    prev = hash
  }

  return { amp: '0.1', kind: 'ledger-snapshot', agent, tip: prev, count: entries.length, entries }
}

/** Structural + cryptographic verification, without trusting `count` or `tip`. */
export function verifySnapshot(snapshot: LedgerSnapshot): SnapshotVerdict {
  const reasons: string[] = []
  if (snapshot.amp !== '0.1' || snapshot.kind !== 'ledger-snapshot') {
    reasons.push('not a ledger snapshot')
  }

  let prev = GENESIS
  snapshot.entries.forEach((entry, index) => {
    if (entry.seq !== index) reasons.push(`entry ${index}: seq ${entry.seq} is out of order`)
    if (entry.prev !== prev) reasons.push(`entry ${index}: prev does not match the previous hash`)
    const expected = hashOf(entry.seq, entry.kind, entry.payload, entry.prev)
    if (entry.hash !== expected) reasons.push(`entry ${index}: hash does not cover its payload`)
    prev = entry.hash
  })

  if (snapshot.count !== snapshot.entries.length) {
    reasons.push(`count ${snapshot.count} does not match ${snapshot.entries.length} entries`)
  }
  if (snapshot.tip !== prev) reasons.push('tip does not match the last entry')

  return { ok: reasons.length === 0, reasons }
}

export interface RestoredLedger {
  events: unknown[]
  frames: unknown[]
  receipts: unknown[]
  claims: unknown[]
  hypotheses: unknown[]
  unknowns: unknown[]
  goals: unknown[]
  plans: unknown[]
}

/** Restores only a verified snapshot; a tampered one throws instead of loading. */
export function restoreLedger(snapshot: LedgerSnapshot): RestoredLedger {
  const verdict = verifySnapshot(snapshot)
  if (!verdict.ok) {
    throw new Error(`refusing to restore a broken snapshot: ${verdict.reasons.join('; ')}`)
  }

  const out: RestoredLedger = {
    events: [],
    frames: [],
    receipts: [],
    claims: [],
    hypotheses: [],
    unknowns: [],
    goals: [],
    plans: [],
  }
  const bucket: Record<EntryKind, unknown[]> = {
    event: out.events,
    frame: out.frames,
    receipt: out.receipts,
    claim: out.claims,
    hypothesis: out.hypotheses,
    unknown: out.unknowns,
    goal: out.goals,
    plan: out.plans,
  }
  for (const entry of snapshot.entries) bucket[entry.kind].push(entry.payload)
  return out
}
