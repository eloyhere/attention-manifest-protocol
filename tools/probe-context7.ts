#!/usr/bin/env node
/** Focused probe: context7's 2026-07-28 header contract. */
const URL_ = 'https://mcp.context7.com/mcp'

function parseSse(text) {
  const joined = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('')
  return JSON.parse(joined)
}

async function rpc(method, params, extra = {}) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  const type = res.headers.get('content-type') ?? ''
  let body
  try {
    body = type.includes('text/event-stream') ? parseSse(text) : JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
}

const discover = await rpc('server/discover', { _meta: meta })
console.log('discover:', discover.status, JSON.stringify(discover.body).slice(0, 400))

const list = await rpc('tools/list', { _meta: meta })
console.log('list:', list.status, JSON.stringify(list.body).slice(0, 300))

const call = await rpc(
  'tools/call',
  { name: 'resolve-library-id', arguments: { query: 'how to use hooks', libraryName: 'react' }, _meta: meta },
  { 'mcp-name': 'resolve-library-id' },
)
console.log('call:', call.status, JSON.stringify(call.body).slice(0, 700))
