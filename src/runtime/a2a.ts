import type { DelegationDoc } from '../types/collaboration.ts'
import { digestOf } from './canonical.ts'
import type { Channel, ChannelVerdict } from './channel.ts'

/** A2A v1.0 Message. Part kinds are text | file | data. */
export interface A2APart {
  kind: 'text' | 'data'
  text?: string
  data?: Record<string, unknown>
}

export interface A2AMessage {
  kind: 'message'
  messageId: string
  role: 'user' | 'agent'
  parts: A2APart[]
  metadata?: Record<string, unknown>
}

export interface A2ARequest {
  jsonrpc: '2.0'
  id: string
  method: 'message/send'
  params: { message: A2AMessage }
}

export interface A2AChannelOptions {
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
}

/**
 * Real A2A v1.0 binding: JSON-RPC `message/send` carrying an A2A Message.
 * The delegation rides in a `data` part plus metadata; a text part keeps the
 * request readable to a peer that does not know AMP yet.
 */
export function toA2ARequest(doc: DelegationDoc): A2ARequest {
  const message: A2AMessage = {
    kind: 'message',
    messageId: doc.id,
    role: 'user',
    parts: [
      { kind: 'text', text: `AMP delegation ${doc.id}: ${doc.granter} -> ${doc.delegatee} (depth ${doc.depth})` },
      { kind: 'data', data: { 'io.amp/delegation': doc } },
    ],
    metadata: { 'io.amp/delegation_digest': digestOf(doc), 'io.amp/version': '0.1' },
  }
  return { jsonrpc: '2.0', id: `amp-${doc.id}`, method: 'message/send', params: { message } }
}

/** Closes the loop: use the endpoint the Agent Card advertised, not a hardcoded URL. */
export function channelFromCard(
  card: { ok: boolean; endpoint?: string },
  options: Omit<A2AChannelOptions, 'url'> = {},
): A2AChannel {
  if (!card.ok || !card.endpoint) throw new Error('agent card has no usable endpoint')
  return new A2AChannel({ url: card.endpoint, ...options })
}

export class A2AChannel implements Channel {
  readonly url: string
  readonly extraHeaders: Record<string, string>
  readonly timeoutMs: number
  readonly requests: A2ARequest[] = []

  constructor(options: A2AChannelOptions) {
    this.url = options.url
    this.extraHeaders = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  async send(doc: DelegationDoc): Promise<ChannelVerdict> {
    const request = toA2ARequest(doc)
    this.requests.push(request)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'a2a-version': '1.0',
          ...this.extraHeaders,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok) return { accepted: false, reason: `HTTP ${response.status}` }

      const body = (await response.json()) as {
        error?: { code: number; message: string }
        result?: { kind?: string; id?: string; status?: { state?: string } }
      }
      if (body.error) return { accepted: false, reason: `A2A ${body.error.code}: ${body.error.message}` }

      const result = body.result
      if (result?.kind === 'task') {
        return { accepted: true, reason: `task ${result.id ?? ''} ${result.status?.state ?? 'submitted'}` }
      }
      if (result?.kind === 'message') return { accepted: true, reason: 'agent replied with a message' }
      return { accepted: false, reason: 'unrecognised A2A result' }
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : String(error)
      return { accepted: false, reason }
    } finally {
      clearTimeout(timer)
    }
  }
}
