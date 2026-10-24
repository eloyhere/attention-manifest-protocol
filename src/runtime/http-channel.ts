import type { DelegationDoc } from '../types/collaboration.ts'
import { digestOf } from './canonical.ts'
import type { Channel, ChannelVerdict } from './channel.ts'

export interface HttpChannelOptions {
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
  /** Retries are only safe because the idempotency key is the document digest. */
  retries?: number
  backoffMs?: number
}

interface Envelope {
  amp: '0.1'
  kind: 'delegation-envelope'
  delegation: DelegationDoc
}

interface Attempt {
  verdict: ChannelVerdict
  retryable: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class HttpTeamChannel implements Channel {
  readonly url: string
  readonly extraHeaders: Record<string, string>
  readonly timeoutMs: number
  readonly retries: number
  readonly backoffMs: number
  readonly sent: Array<{ envelope: Envelope; key: string }> = []
  attempts = 0

  constructor(options: HttpChannelOptions) {
    this.url = options.url
    this.extraHeaders = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.retries = options.retries ?? 0
    this.backoffMs = options.backoffMs ?? 50
  }

  async send(doc: DelegationDoc): Promise<ChannelVerdict> {
    const envelope: Envelope = { amp: '0.1', kind: 'delegation-envelope', delegation: doc }
    const key = digestOf(doc)
    this.sent.push({ envelope, key })

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      this.attempts += 1
      const result = await this.once(envelope, key)
      if (!result.retryable || attempt === this.retries) return result.verdict
      await sleep(this.backoffMs * 2 ** attempt)
    }
    return { accepted: false, reason: 'exhausted without a verdict' }
  }

  private async once(envelope: Envelope, key: string): Promise<Attempt> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, ...this.extraHeaders },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      })
      if (response.status >= 500) {
        return { verdict: { accepted: false, reason: `HTTP ${response.status}` }, retryable: true }
      }
      if (!response.ok) return { verdict: { accepted: false, reason: `HTTP ${response.status}` }, retryable: false }
      const body = (await response.json()) as { accepted?: boolean; reason?: string }
      return { verdict: { accepted: body.accepted === true, reason: body.reason }, retryable: false }
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : String(error)
      return { verdict: { accepted: false, reason }, retryable: true }
    } finally {
      clearTimeout(timer)
    }
  }
}
