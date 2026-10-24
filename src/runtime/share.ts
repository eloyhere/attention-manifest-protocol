import type { Ledger } from './ledger.ts'
import { digestOf } from './canonical.ts'
import { exportLedger } from './persistence.ts'

export type ShareMode = 'full' | 'summary' | 'reference'

export interface SharedView {
  amp: '0.1'
  kind: 'shared-ledger'
  mode: ShareMode
  agent: string
  tip: string
  count: number
  digest: string
  entries?: unknown[]
  summary?: {
    byKind: Record<string, number>
    claims: string[]
  }
}

/**
 * Three sharing granularities, all integrity-checkable.
 *
 * full      — everything; only for a trusted peer in the same domain
 * summary   — counts + claim ids; no payloads
 * reference — tip + count + digest; the receiver must ask for more
 */
export function shareLedger(ledger: Ledger, agent: string, mode: ShareMode): SharedView {
  const snapshot = exportLedger(ledger, agent)
  const base = {
    amp: '0.1' as const,
    kind: 'shared-ledger' as const,
    mode,
    agent,
    tip: snapshot.tip,
    count: snapshot.count,
  }

  if (mode === 'full') {
    return { ...base, digest: digestOf({ ...base, entries: snapshot.entries }), entries: snapshot.entries }
  }

  if (mode === 'summary') {
    const byKind: Record<string, number> = {}
    const claims: string[] = []
    for (const entry of snapshot.entries) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
      if (entry.kind === 'claim') {
        const payload = entry.payload as { id?: string }
        if (payload.id) claims.push(payload.id)
      }
    }
    return { ...base, digest: digestOf({ ...base, byKind, claims }), summary: { byKind, claims } }
  }

  return { ...base, digest: digestOf(base) }
}
