import type { AmpEvent, Receipt } from '../types/receipt.ts'
import type { Frame } from '../types/frame.ts'
import type { Claim, Hypothesis, UnknownItem } from '../types/epistemic.ts'
import type { Goal, Plan } from '../types/plan.ts'

/**
 * Append-only ledger (X-1). Nothing is deleted or rewritten; revisions add rows.
 * The reference store is in-memory; a host persists the same arrays as JSONL.
 */
export class Ledger {
  readonly events: AmpEvent[] = []
  readonly frames: Frame[] = []
  readonly receipts: Receipt[] = []
  readonly claims: Claim[] = []
  readonly hypotheses: Hypothesis[] = []
  readonly unknowns: UnknownItem[] = []
  readonly goals: Goal[] = []
  readonly plans: Plan[] = []

  appendEvent(event: AmpEvent): void {
    this.events.push(event)
  }

  findClaim(id: string): Claim | undefined {
    return this.claims.find((c) => c.id === id)
  }

  findUnknown(id: string): UnknownItem | undefined {
    return this.unknowns.find((u) => u.id === id)
  }
}
