import type { Budget, Ref, Timestamp, Usage } from '../types/common.ts'
import type {
  Claim,
  EvidenceItem,
  Hypothesis,
  UnknownItem,
} from '../warrant/epistemic.ts'
import type { Frame, FrameMode, ImpasseState } from '../frame/frame.ts'
import type { Goal, Plan, PlanTask } from './plan.ts'
import type { Capability, Constraint, Manifest, ValueStatement } from '../manifest/manifest.ts'
import type { AmpEvent, Receipt, ReceiptOp } from '../receipt/receipt.ts'

import { Ledger } from '../ledger/ledger.ts'
import { Dispatcher, BudgetExceeded } from '../attention/budget.ts'
import { HandleStore } from '../execution/handles.ts'
import { digestOf } from '../semantic/canonical.ts'
import { deriveConfidence, validateClaim, validateHypothesis } from '../warrant/warrant.ts'
import { selectFocus, type Candidate } from '../attention/attention.ts'
import { PolicyEngine } from '../policy/policy.ts'
import type { Approval, EffectClass } from '../policy/policy.ts'
import { signManifest } from '../manifest/sign.ts'
import type { KeyPair } from '../manifest/sign.ts'

export interface RuntimeOptions {
  agentId: string
  agentName?: string
  role?: string
  /** Fixed start so demo output is deterministic. */
  start?: string
  budget?: Budget
  capabilities?: Capability[]
  values?: ValueStatement[]
  constraints?: Constraint[]
  /** Optional action policy. When configured, `act()` refuses unwarranted actions. */
  policy?: PolicyEngine
}

export interface NoteClaimInput {
  statement: string
  tier: Claim['tier']
  status?: Claim['status']
  claimScope?: Claim['claim_scope']
  evidence?: EvidenceItem[]
  inference?: Claim['warrant']['inference']
  auxiliaryAssumptions?: string[]
  causal?: Claim['causal']
  scope?: string
  alternatives?: Claim['alternatives']
  baseRate?: Claim['base_rate']
  wouldBeFalseIf?: string
  checkRunId?: string
  looks?: number
  /** Set when the user pushes back without new evidence: records an integrity event. */
  underPressure?: boolean
}

export interface NoteHypothesisInput {
  statement: string
  question: Ref
  prediction: string
  refutesIf: string
  prereg?: Hypothesis['prereg']
  auxiliaryAssumptions?: string[]
}

export interface ActInput {
  tool: string
  result: string
  resultTokens: number
  budgetTokens: number
  ms?: number
  /** Effect class for policy checks; defaults to a reversible write. */
  effect?: EffectClass
  /** Warrant for the action. Required by the policy for every non-read effect. */
  claim?: Claim
  /** Host-issued approval for a high-risk effect. */
  approval?: Approval
  /** Recorded before the call so the controller can be calibrated afterwards. */
  predictedVoi?: number
  realizedVoi?: number
}

export interface AttendResult {
  frame: Frame
  receipt: Receipt
}

export interface PlanInput {
  tasks: PlanTask[]
  edges?: Array<[string, string]>
  budget: Budget
  abandonIf: Plan['abandon_if']
  commitmentWindow?: number
  process?: Ref
  rollback?: string
}

/**
 * Reference AMP runtime (L0/L1 scope).
 *
 * It enforces the invariants that can be enforced in-process: derived confidence,
 * hard budgets, handle-based overflow, ignore lists, immutable frame chains.
 * It deliberately does NOT implement signing, sandboxing, or multi-tenant isolation.
 */
export class AmpRuntime {
  readonly ledger = new Ledger()
  readonly handles = new HandleStore()

  private readonly agentId: string
  private readonly agentName: string
  private readonly role: string
  private readonly startMs: number
  private readonly dispatcher: Dispatcher
  private readonly capabilities: Capability[]
  private readonly values: ValueStatement[]
  private readonly constraints: Constraint[]
  private readonly policy?: PolicyEngine

  private tick = 0
  private cycle = 0
  private seq = 0
  private lastFrame: Frame | undefined

  constructor(options: RuntimeOptions) {
    this.agentId = options.agentId
    this.agentName = options.agentName ?? options.agentId
    this.role = options.role ?? 'agent'
    this.startMs = Date.parse(options.start ?? '2026-10-24T01:10:00Z')
    this.dispatcher = new Dispatcher(options.budget ?? { tokens: 24_000, calls: 40, ms: 600_000 })
    this.capabilities = options.capabilities ?? []
    this.values = options.values ?? []
    this.constraints = options.constraints ?? []
    this.policy = options.policy
  }

  /* ------------------------------- clock ------------------------------- */

  private now(): Timestamp {
    this.tick += 1
    return new Date(this.startMs + this.tick * 1000).toISOString()
  }

  /** Public clock for collaborators (Exec profile) so all receipts share one timeline. */
  nowIso(): Timestamp {
    return this.now()
  }

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}.${this.seq}`
  }

  private ref(kind: Ref['kind'], id: string): Ref {
    return { kind, id }
  }

  private emit(type: string, refs: Ref[], payload: Record<string, unknown>): void {
    const base: Omit<AmpEvent, 'digest'> = {
      amp: '0.1',
      kind: 'event',
      id: this.nextId('ev'),
      at: this.now(),
      actor: this.ref('self', this.agentId),
      type,
      refs,
      payload,
    }
    const event: AmpEvent = { ...base, digest: digestOf(base) }
    this.ledger.appendEvent(event)
  }

  private receipt(
    op: ReceiptOp,
    target: Ref,
    usage: Usage,
    outcome: Receipt['outcome'],
    extra: Partial<Receipt> = {},
  ): Receipt {
    const receipt: Receipt = {
      amp: '0.1',
      kind: 'receipt',
      id: this.nextId('rc'),
      op,
      target,
      at: this.now(),
      usage,
      outcome,
      ...extra,
    }
    this.ledger.receipts.push(receipt)
    return receipt
  }

  /* ------------------------------ warrant ------------------------------ */

  noteUnknown(input: {
    question: string
    importance: number
    blocking: boolean
    resolveCost?: Budget
  }): { unknown: UnknownItem; receipt: Receipt } {
    const unknown: UnknownItem = {
      amp: '0.1',
      kind: 'unknown',
      id: this.nextId('u'),
      question: input.question,
      importance: input.importance,
      blocking: input.blocking,
      since: this.now(),
      resolve_cost: input.resolveCost,
      status: 'open',
    }
    this.ledger.unknowns.push(unknown)
    const receipt = this.receipt('note', this.ref('unknown', unknown.id), { tokens: 0, calls: 0 }, 'success')
    return { unknown, receipt }
  }

  noteClaim(input: NoteClaimInput): {
    claim?: Claim
    receipt: Receipt
    problems: string[]
  } {
    const evidence = input.evidence ?? []

    if (input.underPressure) {
      const existing = this.ledger.claims.find((c) => c.statement === input.statement)
      if (existing) {
        this.emit('integrity.sycophancy_pressure', [this.ref('claim', existing.id)], {
          statement: input.statement,
        })
        const receipt = this.receipt('note', this.ref('claim', existing.id), { tokens: 0, calls: 0 }, 'blocked', {
          note: 'confidence unchanged: no new evidence under pressure',
        })
        return { claim: existing, receipt, problems: [] }
      }
    }

    const base: Claim = {
      amp: '0.1',
      kind: 'claim',
      id: this.nextId('cl'),
      statement: input.statement,
      claim_scope: input.claimScope,
      tier: input.tier,
      status: input.status ?? 'held',
      would_be_false_if: input.wouldBeFalseIf,
      check_run_id: input.checkRunId,
      looks: input.looks,
      causal: input.causal,
      warrant: {
        evidence,
        inference: input.inference ?? 'abduction',
        auxiliary_assumptions: input.auxiliaryAssumptions,
        strength: 0.7,
      },
      alternatives: input.alternatives,
      base_rate: input.baseRate,
      scope: input.scope,
      provenance: { source: this.agentId, kind: 'inference', trust: 'self', at: this.now() },
      created: this.now(),
    }

    const problems = validateClaim(base)
    if (problems.length > 0) {
      const receipt = this.receipt('note', this.ref('claim', base.id), { tokens: 0, calls: 0 }, 'blocked', {
        note: problems.join('; '),
      })
      return { receipt, problems }
    }

    const claim: Claim = { ...base, confidence: deriveConfidence(base) }
    this.ledger.claims.push(claim)
    const receipt = this.receipt('note', this.ref('claim', claim.id), { tokens: 0, calls: 0 }, 'success')
    return { claim, receipt, problems: [] }
  }

  noteHypothesis(input: NoteHypothesisInput): {
    hypothesis?: Hypothesis
    receipt: Receipt
    problems: string[]
  } {
    const hypothesis: Hypothesis = {
      amp: '0.1',
      kind: 'hypothesis',
      id: this.nextId('h'),
      question: input.question,
      statement: input.statement,
      prediction: input.prediction,
      refutes_if: input.refutesIf,
      auxiliary_assumptions: input.auxiliaryAssumptions,
      prereg: input.prereg,
      labels: [input.prereg ? 'confirmatory' : 'exploratory'],
      status: 'testing',
      created: this.now(),
    }

    const problems = validateHypothesis(hypothesis)
    if (problems.length > 0) {
      const receipt = this.receipt('note', this.ref('hypothesis', hypothesis.id), { tokens: 0, calls: 0 }, 'blocked', {
        note: problems.join('; '),
      })
      return { receipt, problems }
    }

    this.ledger.hypotheses.push(hypothesis)
    const receipt = this.receipt('note', this.ref('hypothesis', hypothesis.id), { tokens: 0, calls: 0 }, 'success')
    return { hypothesis, receipt, problems: [] }
  }

  /* ----------------------------- attention ----------------------------- */

  attend(candidates: Candidate[], budgetTokens: number, mode: FrameMode = 'triage'): AttendResult {
    const selection = selectFocus(candidates, { budgetTokens })
    this.cycle += 1

    const base: Omit<Frame, 'digest'> = {
      amp: '0.1',
      kind: 'frame',
      id: `f.${100 + this.cycle}`,
      agent: this.agentId,
      cycle: this.cycle,
      ts: this.now(),
      parent: this.lastFrame ? this.ref('frame', this.lastFrame.id) : undefined,
      mode,
      slots: selection.slots,
      ignored: selection.ignored,
      budget: {
        allocated: { tokens: budgetTokens },
        spent: this.dispatcher.usage(),
      },
      impasse: selection.impasse
        ? ({ state: selection.impasse, detail: 'controller-selected' } as { state: ImpasseState; detail: string })
        : undefined,
    }
    const frame: Frame = { ...base, digest: digestOf(base) }
    this.ledger.frames.push(frame)
    this.lastFrame = frame

    const receipt = this.receipt(
      'attend',
      this.ref('frame', frame.id),
      { tokens: 0, calls: 0 },
      selection.slots.length > 0 ? 'success' : 'blocked',
      { note: selection.impasse },
    )
    return { frame, receipt }
  }

  /* ------------------------------ action ------------------------------- */

  act(input: ActInput): { receipt: Receipt; inline?: string; handle?: string } {
    if (this.policy) {
      const verdict = this.policy.decide(
        {
          action: input.tool,
          target: this.ref('tool', input.tool),
          effect: input.effect ?? 'write-reversible',
          claim: input.claim,
        },
        input.approval,
      )
      if (verdict.outcome !== 'allow') {
        const receipt = this.receipt(
          'act',
          this.ref('tool', input.tool),
          { tokens: 0, calls: 0 },
          'blocked',
          { note: `policy:${verdict.outcome}:${verdict.reason}` },
        )
        return { receipt }
      }
    }

    try {
      this.dispatcher.run(() => undefined, { calls: 1, ms: input.ms ?? 900 })
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        const receipt = this.receipt(
          'act',
          this.ref('tool', input.tool),
          this.dispatcher.usage(),
          'blocked',
          { note: `${error.code}:${error.dimension}` },
        )
        return { receipt }
      }
      throw error
    }

    if (input.resultTokens <= input.budgetTokens) {
      const receipt = this.receipt('act', this.ref('tool', input.tool), this.dispatcher.usage(), 'success', {
        predicted_voi: input.predictedVoi,
        realized_voi: input.realizedVoi,
      })
      return { receipt, inline: input.result }
    }

    const handle = this.handles.put(input.result, 'text', input.resultTokens)
    const receipt = this.receipt('act', this.ref('tool', input.tool), this.dispatcher.usage(), 'success', {
      handle,
      predicted_voi: input.predictedVoi,
      realized_voi: input.realizedVoi,
      note: `result ${input.resultTokens} tokens > budget ${input.budgetTokens}; handle emitted, nothing truncated`,
    })
    return { receipt, handle: handle.id }
  }

  readHandle(id: string, cursor: number, limitTokens?: number): { text: string; next: number | null; receipt: Receipt } {
    const page = this.handles.read(id, cursor, limitTokens)
    const receipt = this.receipt('read', this.ref('handle', id), { tokens: page.tokens }, 'success')
    return { text: page.text, next: page.next, receipt }
  }

  /* ---------------------------- planning ------------------------------- */

  noteGoal(input: { statement: string; success: Goal['success']; value: number; priority?: number }): Goal {
    const goal: Goal = {
      amp: '0.1',
      kind: 'goal',
      id: this.nextId('g'),
      statement: input.statement,
      success: input.success,
      value: input.value,
      priority: input.priority ?? 1,
      horizon: 'task',
    }
    this.ledger.goals.push(goal)
    return goal
  }

  plan(goal: Goal, input: PlanInput): { plan?: Plan; receipt: Receipt; problems: string[] } {
    const problems: string[] = []
    if (input.tasks.length === 0) problems.push('plan requires at least one task')
    if (input.abandonIf.length === 0) problems.push('plan requires abandon_if')
    for (const task of input.tasks) {
      if (!task.expect || !task.expect.observation) problems.push(`task ${task.id} lacks an expected observation`)
    }
    if (hasCycle(input.tasks, input.edges ?? [])) problems.push('task graph contains a cycle')

    if (problems.length > 0) {
      const receipt = this.receipt('plan', this.ref('goal', goal.id), { tokens: 0, calls: 0 }, 'blocked', {
        note: problems.join('; '),
      })
      return { receipt, problems }
    }

    const base: Omit<Plan, 'id'> = {
      amp: '0.1',
      kind: 'plan',
      goal: this.ref('goal', goal.id),
      process: input.process,
      tasks: input.tasks,
      edges: input.edges ?? [],
      commitment_window: input.commitmentWindow ?? 1,
      budget: input.budget,
      abandon_if: input.abandonIf,
      rollback: input.rollback,
      status: 'committed',
      created: this.now(),
    }
    const plan: Plan = { ...base, id: this.nextId('pl') }
    this.ledger.plans.push(plan)
    const receipt = this.receipt('plan', this.ref('plan', plan.id), { tokens: 0, calls: 0 }, 'success')
    return { plan, receipt, problems: [] }
  }

  /* ---------------------------- reflection ----------------------------- */

  calibration(): { samples: number; mae: number } {
    const scored = this.ledger.receipts.filter(
      (r) => typeof r.predicted_voi === 'number' && typeof r.realized_voi === 'number',
    )
    if (scored.length === 0) return { samples: 0, mae: 0 }
    const mae =
      scored.reduce((sum, r) => sum + Math.abs((r.predicted_voi ?? 0) - (r.realized_voi ?? 0)), 0) /
      scored.length
    return { samples: scored.length, mae: Math.round(mae * 1000) / 1000 }
  }

  reflect(): { samples: number; mae: number; receipt: Receipt } {
    const result = this.calibration()
    const receipt = this.receipt(
      'reflect',
      this.ref('self', this.agentId),
      { tokens: 0, calls: 0 },
      'success',
      { note: `voi_mae=${result.mae} over ${result.samples} samples` },
    )
    return { ...result, receipt }
  }

  /* ----------------------------- manifest ------------------------------ */

  manifest(): Manifest {
    const calibration = this.calibration()
    const base: Omit<Manifest, 'digest' | 'signatures'> = {
      amp: '0.1',
      kind: 'manifest',
      agent: { id: this.agentId, name: this.agentName, version: '0.1.0', role: this.role },
      issued: this.now(),
      expires: new Date(this.startMs + 24 * 3600 * 1000).toISOString(),
      identity: { values: this.values, constraints: this.constraints },
      capabilities: this.capabilities,
      concepts: [],
      commitments: [],
      unknowns: this.ledger.unknowns.map((u) => ({
        id: u.id,
        question: u.question,
        importance: u.importance,
        blocking: u.blocking,
        since: u.since,
      })),
      attention: {
        policy_digest: digestOf({ salience: 'amp-ref-1', cap: 7, threshold: 0.12 }),
        frame: this.lastFrame ? this.ref('frame', this.lastFrame.id) : undefined,
        budget: { tokens: 24_000, ms: 600_000, calls: 40, interrupts: 2 },
      },
      self: {
        calibration: { ece: calibration.mae, buckets: [] },
        limits: ['reference runtime: no signing', 'no sandbox execution', 'in-memory ledger only'],
        state: { load: 0.4, mode: 'exploit' },
      },
    }
    const manifest: Manifest = {
      ...base,
      digest: digestOf(base),
      signatures: [
        {
          role: 'self',
          alg: 'ed25519',
          kid: `${this.agentId}#ref`,
          sig: 'unsigned-reference-runtime',
        },
      ],
    }
    return manifest
  }

  /**
   * Produces the same Manifest with a real Ed25519 self-signature.
   *
   * `manifest()` stays synchronous and unsigned so existing deterministic
   * demos keep working; hosts that need a verifiable declaration call this.
   */
  async signedManifest(key: KeyPair): Promise<Manifest> {
    const full = this.manifest()
    const unsigned: Omit<Manifest, 'digest' | 'signatures'> = {
      amp: full.amp,
      kind: full.kind,
      agent: full.agent,
      issued: full.issued,
      expires: full.expires,
      identity: full.identity,
      capabilities: full.capabilities,
      concepts: full.concepts,
      commitments: full.commitments,
      unknowns: full.unknowns,
      attention: full.attention,
      self: full.self,
    }
    return signManifest(unsigned, key)
  }

  /* --------------------------- diagnostics ----------------------------- */

  /** Checks the invariants a host can verify without side effects. */
  audit(): string[] {
    const problems: string[] = []

    for (const frame of this.ledger.frames) {
      for (const slot of frame.slots) {
        if (!slot.why) problems.push(`A-1: slot ${slot.target.id} in ${frame.id} has no why`)
        if (!slot.cost) problems.push(`A-1: slot ${slot.target.id} in ${frame.id} has no cost`)
      }
      if (frame.slots.length > 0 && !frame.ignored) {
        // Not a hard violation (nothing may have been relevant), only a smell.
        problems.push(`A-2: frame ${frame.id} has slots but no ignored list`)
      }
    }

    for (const claim of this.ledger.claims) {
      const violations = validateClaim(claim)
      for (const v of violations) problems.push(`W-5: ${claim.id} ${v}`)
      if (claim.confidence !== undefined) {
        const derived = deriveConfidence(claim)
        if (Math.abs(derived - claim.confidence) > 0.001) {
          problems.push(`M-1: ${claim.id} stored confidence ${claim.confidence} != derived ${derived}`)
        }
      }
    }

    for (const hypothesis of this.ledger.hypotheses) {
      for (const v of validateHypothesis(hypothesis)) problems.push(`W-2: ${hypothesis.id} ${v}`)
    }

    return problems
  }
}

/* ------------------------------ helpers ------------------------------- */

function hasCycle(tasks: PlanTask[], edges: Array<[string, string]>): boolean {
  const ids = new Set(tasks.map((t) => t.id))
  const adjacency = new Map<string, string[]>()
  for (const id of ids) adjacency.set(id, [])
  for (const [from, to] of edges) {
    if (!ids.has(from) || !ids.has(to)) return true
    adjacency.get(from)?.push(to)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true
    if (visited.has(node)) return false
    visiting.add(node)
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true
    }
    visiting.delete(node)
    visited.add(node)
    return false
  }

  for (const id of ids) {
    if (visit(id)) return true
  }
  return false
}
