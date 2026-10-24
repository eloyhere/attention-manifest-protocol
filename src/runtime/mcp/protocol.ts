/** Minimal MCP 2026-07-28 surface used by the Exec profile. */

export const PROTOCOL_VERSION = '2026-07-28'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  /** Absent for notifications (e.g. notifications/initialized). */
  id?: number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcErrorBody
}

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface DiscoveryResult {
  resultType: 'complete'
  supportedVersions: string[]
  capabilities: { tools?: Record<string, unknown>; extensions?: Record<string, unknown> }
  instructions?: string
  ttlMs: number
  cacheScope: 'public' | 'private'
}

export interface ListToolsResult {
  resultType: 'complete'
  tools: McpTool[]
  ttlMs: number
  cacheScope: 'public' | 'private'
}

export interface CallToolResult {
  resultType: 'complete'
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

export class McpProtocolError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'McpProtocolError'
    this.code = code
    this.data = data
  }
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
}
