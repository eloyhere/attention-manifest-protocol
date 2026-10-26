import type { Digest, Id, Timestamp } from '../types/common.ts'
import type { Hypothesis } from './epistemic.ts'
import { digestOf } from '../semantic/canonical.ts'

export interface ExperimentLook {
  value: number
  at: Timestamp
}

export interface Experiment {
  id: Id
  hypothesis: Id
  preregHash: Digest
  metric: string
  stopping: string
  exclusions: string[]
  registeredAt: Timestamp
  status: 'registered' | 'running' | 'completed' | 'abandoned'
  looks: ExperimentLook[]
  verdict?: 'supported' | 'refuted' | 'inconclusive'
  warnings: string[]
}

export interface RunContext {
  runId: string
  seed: string
  origin: string
  environment?: string
}

export interface ReplicationVerdict {
  ok: boolean
  reasons: string[]
  tier: 'T3' | 'T4'
}

/** Content the pre-registration hash must cover. Order is fixed by canonical(); shape is not. */
export function preregHashOf(input: {
  statement: string
  metric: string
  stopping: string
  exclusions?: string[]
}): Digest {
  return digestOf({
    statement: input.statement,
    metric: input.metric,
    stopping: input.stopping,
    exclusions: input.exclusions ?? [],
  })
}

/**
 * Inquiry log: registration happens before observation, and re-asking is
 * recorded as another look rather than as a fresh, clean experiment.
 */
export class InquiryLog {
  private readonly experiments = new Map<Id, Experiment>()
  private readonly now: () => Timestamp
  private seq = 0

  constructor(options: { now: () => Timestamp }) {
    this.now = options.now
  }

  register(hypothesis: Hypothesis, options: { exclusions?: string[] } = {}): Experiment {
    if (!hypothesis.prereg) {
      throw new Error('hypothesis must be pre-registered before an experiment can start')
    }
    const expected = preregHashOf({
      statement: hypothesis.statement,
      metric: hypothesis.prereg.metric,
      stopping: hypothesis.prereg.stopping,
      exclusions: hypothesis.prereg.exclusions ?? options.exclusions ?? [],
    })
    if (expected !== hypothesis.prereg.hash) {
      throw new Error('prereg hash does not match its content: the hypothesis changed after registration')
    }

    this.seq += 1
    const experiment: Experiment = {
      id: `ex.${this.seq}`,
      hypothesis: hypothesis.id,
      preregHash: hypothesis.prereg.hash,
      metric: hypothesis.prereg.metric,
      stopping: hypothesis.prereg.stopping,
      exclusions: hypothesis.prereg.exclusions ?? options.exclusions ?? [],
      registeredAt: hypothesis.prereg.registered_at,
      status: 'running',
      looks: [],
      warnings: [],
    }
    this.experiments.set(experiment.id, experiment)
    return experiment
  }

  /** A look is any observation of the outcome. Recording it is mandatory, not optional. */
  observe(experimentId: Id, value: number): Experiment {
    const experiment = this.experiment(experimentId)
    if (experiment.status === 'completed') throw new Error('experiment already completed')
    if (experiment.status === 'abandoned') throw new Error('experiment abandoned')

    if (experiment.stopping === 'fixed_n_10m' && experiment.looks.length >= 1) {
      experiment.warnings.push('extra look beyond the pre-registered fixed-n design')
    }
    experiment.looks.push({ value, at: this.now() })
    return experiment
  }

  conclude(experimentId: Id, verdict: 'supported' | 'refuted' | 'inconclusive'): Experiment {
    const experiment = this.experiment(experimentId)
    if (experiment.looks.length === 0) throw new Error('cannot conclude without a single look')
    experiment.verdict = verdict
    experiment.status = 'completed'
    return experiment
  }

  /** Tier earned by the experiment itself: T3 only when it ran and was pre-registered. */
  tierOf(experimentId: Id): 'T2' | 'T3' {
    const experiment = this.experiment(experimentId)
    return experiment.status === 'completed' ? 'T3' : 'T2'
  }

  experiment(id: Id): Experiment {
    const found = this.experiments.get(id)
    if (!found) throw new Error(`unknown experiment: ${id}`)
    return found
  }

  list(): Experiment[] {
    return [...this.experiments.values()]
  }
}

/** T4 needs an independent re-run: different run, different seed, different origin. */
export function replicationCheck(original: RunContext, replica: RunContext): ReplicationVerdict {
  const reasons: string[] = []
  if (!original.runId || !replica.runId) reasons.push('run ids are required')
  if (original.runId === replica.runId) reasons.push('same run: re-asking is not replication')
  if (original.seed === replica.seed) reasons.push('same seed: not an independent sample')
  if (original.origin === replica.origin) reasons.push('same origin: not independent testimony')
  if (replica.environment !== undefined && original.environment === replica.environment) {
    reasons.push('same environment: weaker replication (allowed, but not sufficient alone for T4)')
  }

  const fatal = reasons.filter((reason) => !reason.startsWith('same environment'))
  return { ok: fatal.length === 0, reasons, tier: fatal.length === 0 ? 'T4' : 'T3' }
}
