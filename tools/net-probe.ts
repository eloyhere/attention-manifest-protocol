#!/usr/bin/env node
/**
 * Probe v2: adds the MCP-Protocol-Version header and parses SSE frames.
 * Focus: what do real servers actually return for server/discover, and what
 * arguments do their tools take?
 */
const TARGETS = [
  { name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' },
  { name: 'mslearn', url: 'https://learn.microsoft.com/api/mcp' },
  { name: 'context7', url: 'https://mcp.context7.com/mcp' },
]

const BASE = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'user-agent': 'amp-reference/0.1 (probe)',
}

function parseSse(text) {
  const lines = text.split(/\r?\n/)
  const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  const joined = data.join('')
  if (!joined) throw new Error('no SSE data frame')
  return JSON.parse(joined)
}

async function rpc(url, method, params, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...BASE, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: controller.signal,
    })
    const text = await res.text()
    const contentType = res.headers.get('content-type') ?? ''
    let body
    try {
      body = contentType.includes('text/event-stream') ? parseSse(text) : JSON.parse(text)
    } catch {
      body = { parseError: text.slice(0, 200) }
    }
    return {
      status: res.status,
      session: res.headers.get('mcp-session-id'),
      contentType,
      body,
    }
  } catch (error) {
    return { status: 0, error: error.name === 'AbortError' ? 'timeout' : error.message }
  } finally {
    clearTimeout(timer)
  }
}

for (const target of TARGETS) {
  console.log(`\n=== ${target.name}  ${target.url}`)

  const init = await rpc(target.url, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'amp-probe', version: '0.1.0' },
  })
  if (init.status === 0) {
    console.log(`  initialize: NETWORK ERROR (${init.error})`)
    continue
  }
  const sessionId = init.session
  const sessionHeaders = sessionId ? { 'mcp-session-id': sessionId } : {}
  console.log(`  initialize: ${init.status}  protocol=${init.body?.result?.protocolVersion ?? '?'}  session=${sessionId ? 'yes' : 'no'}`)

  if (init.body?.result) {
    await rpc(target.url, 'notifications/initialized', {}, sessionHeaders)
    console.log('  notifications/initialized sent')
  }

  const discover = await rpc(
    target.url,
    'server/discover',
    {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
    { ...sessionHeaders, 'mcp-protocol-version': '2026-07-28' },
  )
  console.log(`  server/discover: HTTP ${discover.status}`)
  if (discover.body?.result) {
    console.log(`    result: ${JSON.stringify(discover.body.result).slice(0, 260)}`)
  } else {
    console.log(`    error: ${JSON.stringify(discover.body?.error ?? discover.body).slice(0, 260)}`)
  }

  const list = await rpc(target.url, 'tools/list', {}, sessionHeaders)
  const tools = list.body?.result?.tools ?? []
  console.log(`  tools/list: ${list.status}  tools=${tools.length}`)
  for (const tool of tools.slice(0, 3)) {
    const required = tool.inputSchema?.required ?? []
    const props = Object.keys(tool.inputSchema?.properties ?? {})
    console.log(`    - ${tool.name}  required=[${required.join(',')}]  props=[${props.slice(0, 5).join(',')}]`)
  }
}
