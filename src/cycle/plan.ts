/**
 * AMP v0.1 — planning objects: goal | process | plan.
 * Mirrors docs/schemas/plan.schema.json.
 *
 * Process answers "how does the world work"; Plan answers "what will I do".
 * Conflating them is the most common planning failure.
 */
import type { Budget, Confidence, Criterion, Id, Ref, Timestamp } from '../types/common.ts'

export interface Goal {
  amp: '0.1'
  kind: 'goal'
  id: Id
  statement: string
  /** At least one observable success criterion. A goal without one is a wish. */
  success: Criterion[]
  value: Confidence
  priority: number
  deadline?: Timestamp
  horizon?: 'task' | 'session' | 'long'
}

export interface ProcessActor {
  kind: 'human' | 'agent' | 'tool'
  id: Id
  permissions?: string[]
}

export interface ProcessStage {
  id: Id
  actor: Id
  action: string
  consumes?: string
  produces?: string
}

export interface ObservationPoint {
  stage: Id
  signal: string
  where: string
}

export interface FailureMode {
  mode: string
  signal: string
  /** A check that distinguishes this cause from the others. Without it, diagnosis is a guess. */
  discriminating_test: string
  mitigation: string
}

/** Running this process yourself is how the agent earns causal claims about it (T3). */
export interface Process {
  amp: '0.1'
  kind: 'process'
  id: Id
  label: string
  purpose: string
  actors: ProcessActor[]
  stages: ProcessStage[]
  invariants: string[]
  observability?: ObservationPoint[]
  failure_modes?: FailureMode[]
  causal_edges?: Array<[Id, string]>
  unknowns?: string[]
  confidence: Confidence
  provenance: import('../types/common.ts').Provenance
}

export interface Expectation {
  observation: string
  check: string
}

export interface PlanTask {
  id: Id
  intent: string
  actor: 'self' | 'tool' | 'other'
  ref?: Ref
  pre: string[]
  /** Mandatory: a task without an expected observation cannot be monitored. */
  expect: Expectation
  /** 0 = free to undo · 3 = irreversible. Drives the minimum required tier. */
  irreversibility: 0 | 1 | 2 | 3
  budget?: Budget
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
}

export interface MonitorTrigger {
  when: string
  action: 'retry' | 'adjust' | 'recompose' | 'replan' | 'abandon'
}

export interface PlanMonitor {
  triggers?: MonitorTrigger[]
}

export interface Plan {
  amp: '0.1'
  kind: 'plan'
  id: Id
  goal: Ref
  process?: Ref
  tasks: PlanTask[]
  edges: Array<[string, string]>
  /** How many steps to run before deliberating again. Small = flexible and expensive. */
  commitment_window: number
  budget: Budget
  abandon_if: Criterion[]
  monitor?: PlanMonitor
  rollback?: string
  warrant?: Ref
  status: 'draft' | 'committed' | 'executing' | 'done' | 'abandoned'
  created: Timestamp
}

export type PlanningObject = Goal | Process | Plan
