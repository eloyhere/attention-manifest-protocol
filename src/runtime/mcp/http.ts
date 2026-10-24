import type { JsonRpcRequest, JsonRpcResponse } from './protocol.ts'
import type { Transport } from './transport.ts'

export interface HttpTransportOptions {
  url: string
  /** 2026-07-28 servers reject bodies whose envelope disagrees with the headers. */
  protocolVersion?: string
  sessionId?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

function parseSse(text: string): JsonRpcResponse {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('')
  if (!data) throw new Error('empty SSE response')
  return JSON.parse(data) as JsonRpcResponse
}

/**
 * Streamable-HTTP transport.
 *
 * The 2026-07-28 binding mirrors the JSON-RPC envelope into headers:
 * `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for tools/call.
 * Omitting them is what a real server (context7) reports as -32020.
 */
export class HttpTransport implements Transport {
  readonly url: string
  /** Mutable: legacy handshakes need 2025-06-18 before the version is negotiated. */
  protocolVersion: string
  readonly extraHeaders: Record<string, string>
  readonly timeoutMs: number
  sessionId?: string
  sent = 0

  constructor(options: HttpTransportOptions) {
    this.url = options.url
    this.protocolVersion = options.protocolVersion ?? '2026-07-28'
    this.sessionId = options.sessionId
    this.extraHeaders = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.sent += 1
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.protocolVersion,
      'mcp-method': request.method,
      ...this.extraHeaders,
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const toolName = request.params?.name
    if (request.method === 'tools/call' && typeof toolName === 'string') {
      headers['mcp-name'] = toolName
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      const session = response.headers.get('mcp-session-id')
      if (session) this.sessionId = session

      const text = await response.text()
      if (text.trim().length === 0) {
        // Notifications (202 Accepted) carry no body.
        return { jsonrpc: '2.0', id: request.id ?? 0, result: null }
      }
      const contentType = response.headers.get('content-type') ?? ''
      const payload = contentType.includes('text/event-stream')
        ? parseSse(text)
        : (JSON.parse(text) as JsonRpcResponse)

      if (!response.ok && !payload.error) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
      }
      return payload
    } finally {
      clearTimeout(timer)
    }
  }
}
