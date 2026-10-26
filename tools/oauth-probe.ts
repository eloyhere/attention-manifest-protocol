#!/usr/bin/env node
/**
 * OAuth discovery probe (RFC 9728 protected-resource metadata, RFC 8414 AS metadata).
 * We cannot complete a user-authorization flow headlessly; this verifies the chain
 * AMP's client would have to follow, and what it must implement (CIMD, resource id).
 */
const TARGETS = ['https://mcp.linear.app/mcp', 'https://mcp.figma.com/mcp']

async function post(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'amp-probe', version: '0.1.0' } },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  return { status: res.status, authenticate: res.headers.get('www-authenticate'), body: (await res.text()).slice(0, 160) }
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, text: text.slice(0, 160) }
  }
}

for (const url of TARGETS) {
  console.log(`\n=== ${url}`)
  const init = await post(url)
  console.log(`initialize: HTTP ${init.status}`)
  console.log(`www-authenticate: ${init.authenticate ?? '(none)'}`)

  const match = init.authenticate?.match(/resource_metadata="([^"]+)"/)
  if (!match) {
    console.log('no resource_metadata pointer; cannot continue discovery')
    continue
  }

  const prm = await getJson(match[1])
  console.log(`PRM: HTTP ${prm.status}`)
  console.log(`  resource: ${prm.json?.resource}`)
  console.log(`  authorization_servers: ${JSON.stringify(prm.json?.authorization_servers)}`)
  console.log(`  scopes_supported: ${JSON.stringify(prm.json?.scopes_supported ?? [])}`)
  console.log(`  signed_metadata present: ${Boolean(prm.json?.signed_metadata)}`)

  const asUrl = prm.json?.authorization_servers?.[0]
  if (!asUrl) continue

  const candidates = [
    `${asUrl.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
    `${asUrl.replace(/\/$/, '')}/.well-known/openid-configuration`,
  ]
  for (const candidate of candidates) {
    const as = await getJson(candidate)
    if (as.status !== 200) continue
    console.log(`AS metadata (${candidate}): HTTP ${as.status}`)
    console.log(`  issuer: ${as.json?.issuer}`)
    console.log(`  registration_endpoint: ${as.json?.registration_endpoint ?? '(none)'}`)
    console.log(`  token_endpoint: ${as.json?.token_endpoint ?? '(none)'}`)
    console.log(`  client_id_metadata_document_supported: ${as.json?.client_id_metadata_document_supported ?? '(absent)'}`)
    console.log(`  code_challenge_methods_supported: ${JSON.stringify(as.json?.code_challenge_methods_supported ?? [])}`)
    break
  }
}
