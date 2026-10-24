#!/usr/bin/env node
/** Emits schema-valid team manifest + commitment record for docs/examples. */
const teamManifest = {
  amp: '0.1',
  kind: 'team-manifest',
  id: 'team.incident',
  version: 1,
  members: [
    { id: 'a.lead', role: 'coordinator', capabilities: ['plan', 'merge'], authority: ['assign', 'cancel'] },
    { id: 'a.worker', role: 'investigator', capabilities: ['logs.query', 'metrics.query'], authority: ['tool.logs.query'] },
  ],
  max_depth: 1,
  max_fanout: 3,
  budget: { tokens: 12000, calls: 24, ms: 600000 },
  termination: 'verified',
  attested_at: '2026-10-24T10:00:00Z',
}

const commitment = {
  amp: '0.1',
  kind: 'commitment-record',
  id: 'cm.1',
  parties: ['a.lead', 'a.worker'],
  proposition: 'a.worker 在 11:00 前给出错误窗口的对照结论',
  satisfaction: [
    { id: 'c1', statement: '两个窗口的 5xx 计数与差值', check: 'logs.query', kind: 'query' },
  ],
  status: 'active',
  proposed_by: 'a.lead',
  accepted_by: ['a.worker'],
  created: '2026-10-24T10:00:00Z',
}

console.log(JSON.stringify([teamManifest, commitment], null, 2))
