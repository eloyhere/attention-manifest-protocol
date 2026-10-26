#!/usr/bin/env node
/**
 * LIVE legacy-compatibility test.
 * deepwiki and mslearn only speak 2025-06-18/2025-11-25: discover is absent,
 * so the client must fall back to initialize + session + notifications/initialized.
 */
import { ExecProfile } from '../src/execution/exec.ts'
import { HandleStore } from '../src/execution/handles.ts'
import { McpClient } from '../src/module/mcp/client.ts'
import { HttpTransport } from '../src/module/mcp/http.ts'

const ENDPOINTS = [
  { name: 'mslearn', url: 'https://learn.microsoft.com/api/mcp', tool: 'microsoft_docs_search', args: { query: 'Azure Functions' } },
  { name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', tool: 'read_wiki_structure', args: { repoName: 'facebook/react' } },
]

for (const endpoint of ENDPOINTS) {
  console.log(`\n=== ${endpoint.name}  ${endpoint.url}`)
  const transport = new HttpTransport({ url: endpoint.url, protocolVersion: '2025-06-18' })
  const client = new McpClient(transport, 'amp-live-legacy')

  const mode = await client.negotiate()
  console.log(`negotiate: mode=${mode.mode}  protocol=${client.protocolVersion}  session=${transport.sessionId ? 'yes' : 'no'}`)

  const handles = new HandleStore()
  let tick = 0
  const now = () => new Date(Date.UTC(2026, 9, 24, 3, 0, tick++)).toISOString()
  const receipts = []
  const exec = new ExecProfile(client, {
    budget: { calls: 5, ms: 60_000 },
    handles,
    now,
    maxResultTokens: 300,
    requireApproval: true,
    onReceipt: (receipt) => receipts.push(receipt),
  })

  const snapshot = await exec.connect()
  console.log(`tools: ${snapshot.tools.length}  (${snapshot.tools.map((t) => t.name).join(', ')})`)

  const out = await exec.call(endpoint.tool, endpoint.args, {
    effect: 'read',
    budgetTokens: 300,
    predictedVoi: 0.6,
    realizedVoi: 0.55,
  })
  console.log(`call: outcome=${out.receipt.outcome}  tokens=${out.tokens}  handle=${out.handle ?? 'inline'}`)
  const preview = out.handle ? handles.read(out.handle, 0, 80).text : (out.inline ?? '')
  console.log(`preview: ${preview.replace(/\s+/g, ' ').slice(0, 220)}…`)
}
