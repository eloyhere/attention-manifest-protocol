#!/usr/bin/env node
/** Emits a schema-valid federation bundle + attestation for docs/examples. */
import { attest, exportBundle } from '../src/manifest/federation.ts'
import { generateSigningKey, signManifest } from '../src/manifest/sign.ts'

const agentKey = await generateSigningKey('a.gamma#1')
const orgKey = await generateSigningKey('org.acme#2')

const manifest = await signManifest(
  {
    amp: '0.1',
    kind: 'manifest',
    agent: { id: 'a.gamma', name: 'Gamma', version: '0.1.0', role: 'analyst' },
    issued: '2026-10-24T07:00:00Z',
    expires: '2026-10-25T07:00:00Z',
    capabilities: [
      { id: 'logs.query', label: '查询日志', kind: 'tool', confidence: 0.9, tier: 'T2', cost: { calls: 1 } },
    ],
    attention: { policy_digest: 'sha256:' + '0'.repeat(64), budget: { tokens: 24000, calls: 40 } },
    self: { calibration: { ece: 0.1, buckets: [] }, limits: [], state: { load: 0.4, mode: 'exploit' } },
  },
  agentKey,
)

const attestation = await attest({
  id: 'at.7',
  issuer: { kind: 'org', id: 'org.acme' },
  manifest,
  scope: ['reviewed', 'read-only-ok'],
  issued: '2026-10-24T07:05:00Z',
  expires: '2027-01-24T07:05:00Z',
  key: orgKey,
})

const bundle = await exportBundle(manifest, agentKey, {
  issued: '2026-10-24T07:00:00Z',
  expires: '2026-10-26T07:00:00Z',
  revoked: [],
  attestations: [attestation],
})

console.log(JSON.stringify([bundle, attestation], null, 2))
