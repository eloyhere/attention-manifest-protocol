import type { Budget, Usage } from '../types/common.ts'
import type { Receipt } from '../types/receipt.ts'
import { digestOf } from './canonical.ts'
import { BudgetExceeded, Dispatcher } from './budget.ts'
import { HandleStore } from './handles.ts'
import type { McpClient } from './mcp/client.ts'
import type { McpTool } from './mcp/protocol.ts'
import { textOf } from './mcp/protocol.ts'

export class DriftDetected extends Error {
  readonly code = 'security_event'

  constructor(message: string) {
    super(message)
    this.name = 'DriftDetected'
  }
}

export class ApprovalRequired extends Error {
  readonly code = 'approval_required'

  constructor(tool: string) {
    super(`tool ${tool} is not read-only and requires explicit approval`)
    this.name = 'ApprovalRequired'
  }
}

export class PolicyDenied extends Error {
  readonly code = 'denied'

  constructor(message: string) {
    super(message)
    this.name = 'PolicyDenied'
  }
}

export interface ExecOptions {
  budget: Budget
  handles: HandleStore
  now: () => string
  /** Anything above this becomes a handle. Never truncate. */
  maxResultTokens?: number
  /** If true, non-read-only tools need `approved: true` on each call. */
  requireApproval?: boolean
  onReceipt?: (receipt: Receipt) => void
}

export interface CatalogSnapshot {
  tools: McpTool[]
  digest: string
  ttlMs: number
  expiresAt: number
}

export interface CallOptions {
  approved?: boolean
  budgetTokens?: number
  predictedVoi?: number
  realizedVoi?: number
}

export interface CallOutcome {
  receipt: Receipt
  inline?: string
  handle?: string
  tokens: number
}

/**
 * Exec profile: MCP tools behind the same budget, shaping, and receipt rules
 * as any other action. Digest pinning makes a post-approval metadata change a
 * security event rather than a surprise (Deadbugz / MCPoison).
 */
export class ExecProfile {
  readonly client: McpClient
  readonly dispatcher: Dispatcher

  private readonly handles: HandleStore
  private readonly now: () => string
  private readonly maxResultTokens: number
  private readonly requireApproval: boolean
  private readonly onReceipt?: (receipt: Receipt) => void

  private catalog?: CatalogSnapshot
  private seq = 0

  constructor(client: McpClient, options: ExecOptions) {
    this.client = client
    this.handles = options.handles
    this.now = options.now
    this.maxResultTokens = options.maxResultTokens ?? 1200
    this.requireApproval = options.requireApproval ?? true
    this.onReceipt = options.onReceipt
    this.dispatcher = new Dispatcher(options.budget)
  }

  async connect(): Promise<CatalogSnapshot> {
    await this.client.negotiate()
    const list = await this.client.listTools()
    const snapshot: CatalogSnapshot = {
      tools: list.tools,
      digest: digestOf(list.tools),
      ttlMs: list.ttlMs,
      expiresAt: Date.now() + list.ttlMs,
    }
    this.catalog = snapshot
    return snapshot
  }

  /** Re-list and compare. A different digest fails closed. */
  async refresh(): Promise<CatalogSnapshot> {
    const list = await this.client.listTools()
    const digest = digestOf(list.tools)
    if (this.catalog && digest !== this.catalog.digest) {
      throw new DriftDetected(`tool catalog changed: ${this.catalog.digest} -> ${digest}`)
    }
    const snapshot: CatalogSnapshot = {
      tools: list.tools,
      digest,
      ttlMs: list.ttlMs,
      expiresAt: Date.now() + list.ttlMs,
    }
    this.catalog = snapshot
    return snapshot
  }

  async ensureFresh(): Promise<void> {
    if (!this.catalog) {
      await this.connect()
      return
    }
    if (Date.now() < this.catalog.expiresAt) return
    await this.refresh()
  }

  tools(): McpTool[] {
    return this.catalog?.tools ?? []
  }

  tool(name: string): McpTool | undefined {
    return this.tools().find((tool) => tool.name === name)
  }

  /** Non-throwing drift check for monitoring. */
  async verify(): Promise<{ ok: boolean; digest: string }> {
    const list = await this.client.listTools()
    const digest = digestOf(list.tools)
    return { ok: this.catalog !== undefined && digest === this.catalog.digest, digest }
  }

  async call(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallOutcome> {
    await this.ensureFresh()
    const tool = this.tool(name)
    if (!tool) throw new PolicyDenied(`unknown tool: ${name}`)

    const readOnly = tool.annotations?.readOnlyHint === true
    if (!readOnly && this.requireApproval && options.approved !== true) {
      throw new ApprovalRequired(name)
    }

    const budgetTokens = options.budgetTokens ?? this.maxResultTokens

    let text: string
    try {
      const result = await this.dispatcher.run(() => this.client.callTool(name, args), {
        calls: 1,
        ms: 900,
      })
      text = textOf(result)
    } catch (error) {
      this.receipt(name, this.dispatcher.usage(), 'blocked', {
        note: error instanceof BudgetExceeded ? `${error.code}:${error.dimension}` : String(error),
      })
      throw error
    }

    const tokens = Math.ceil(text.length / 4)
    if (tokens > budgetTokens) {
      const handle = this.handles.put(text, 'text', tokens)
      const receipt = this.receipt(name, this.dispatcher.usage(), 'success', {
        handle,
        predicted_voi: options.predictedVoi,
        realized_voi: options.realizedVoi,
        note: `result ${tokens} tokens > budget ${budgetTokens}; handle emitted, nothing truncated`,
      })
      return { receipt, handle: handle.id, tokens }
    }

    const receipt = this.receipt(name, this.dispatcher.usage(), 'success', {
      predicted_voi: options.predictedVoi,
      realized_voi: options.realizedVoi,
    })
    return { receipt, inline: text, tokens }
  }

  private receipt(
    tool: string,
    usage: Usage,
    outcome: Receipt['outcome'],
    extra: Partial<Receipt> = {},
  ): Receipt {
    this.seq += 1
    const receipt: Receipt = {
      amp: '0.1',
      kind: 'receipt',
      id: `rc.exec.${this.seq}`,
      op: 'act',
      target: { kind: 'tool', id: `mcp.${tool}` },
      at: this.now(),
      usage,
      outcome,
      ...extra,
    }
    this.onReceipt?.(receipt)
    return receipt
  }
}
