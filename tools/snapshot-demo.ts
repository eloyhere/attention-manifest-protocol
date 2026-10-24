#!/usr/bin/env node
/** Emits a schema-valid ledger snapshot for docs/examples. */
import { exportLedger } from '../src/runtime/persistence.ts'
import { AmpRuntime } from '../src/runtime/runtime.ts'

const runtime = new AmpRuntime({ agentId: 'a.gamma', start: '2026-10-24T01:00:00Z' })
runtime.noteUnknown({ question: '错误率上升是发布引起还是流量引起？', importance: 0.9, blocking: true })
runtime.attend(
  [
    {
      target: { kind: 'unknown', id: 'u.1' },
      role: 'question',
      voi: 0.9,
      goalFit: 0.9,
      uncertainty: 0.8,
      novelty: 0.5,
      costTokens: 200,
      risk: 0,
      trustCap: 0.9,
      why: 'blocking unknown',
    },
  ],
  2000,
)
runtime.noteClaim({
  statement: '发布导致错误率上升',
  tier: 'T2',
  evidence: [
    {
      id: 'ev.1',
      kind: 'observation',
      trust: 'self',
      independence: 0.9,
      entails: true,
      origin: 'a',
      at: '2026-10-24T01:00:05Z',
    },
  ],
})

console.log(JSON.stringify(exportLedger(runtime.ledger, 'a.gamma'), null, 2))
