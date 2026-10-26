import type { Digest } from '../types/common.ts'
import { digestOf } from '../semantic/canonical.ts'
import type { McpTool } from '../module/mcp/protocol.ts'

/**
 * Per-tool catalog pinning.
 *
 * The whole-catalog digest in `ExecProfile` is useful for detecting a changed
 * list, but it is checked at connect/refresh time. The TOCTOU window remains:
 * a server can change one tool between that check and the moment its schema is
 * used to validate arguments. These helpers make the pin explicit per tool so
 * a host can re-assert it immediately before a call.
 *
 * `digestTool` covers the fields that influence what the model sees and what
 * arguments are validated: name, title, description, input schema and
 * annotations. It deliberately does not cover the MCP output schema, which is
 * not used for input validation.
 */

export interface ToolPins {
  /**
   * Digest of the tool set, sorted by name.
   *
   * MCP only SHOULD return a deterministic order and AMP must not build a
   * signature or cache on a server-controlled order (architecture §10.6), so
   * reordering the same tools is not drift.
   */
  catalog: Digest
  /** Tool name to per-tool digest. */
  tools: ReadonlyMap<string, Digest>
}

export interface PinVerdict {
  ok: boolean
  reasons: string[]
  /** Names whose digest changed, plus added/removed names. */
  changed: string[]
}

/** Stable digest of one tool, including its description and input schema. */
export function digestTool(tool: McpTool): Digest {
  return digestOf({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? {},
  })
}

/** Build a pin set from a `tools/list` result. Duplicate names fail closed. */
export function pinTools(tools: readonly McpTool[]): ToolPins {
  const pinned = new Map<string, Digest>()
  for (const tool of tools) {
    if (pinned.has(tool.name)) {
      throw new Error(`duplicate tool name in catalog: ${tool.name}`)
    }
    pinned.set(tool.name, digestTool(tool))
  }
  return { catalog: catalogDigest(tools), tools: pinned }
}

/** Order-independent digest of a tool catalog. */
function catalogDigest(tools: readonly McpTool[]): Digest {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return digestOf(sorted)
}

/**
 * Compare a fresh tool list against a previous pin set.
 *
 * The catalog digest catches reordering/removals; per-tool comparison catches a
 * changed description or schema even when the list shape is unchanged.
 */
export function verifyToolPins(pins: ToolPins, tools: readonly McpTool[]): PinVerdict {
  const reasons: string[] = []
  const changed = new Set<string>()
  const current = new Map<string, McpTool>()

  for (const tool of tools) {
    if (current.has(tool.name)) {
      reasons.push(`duplicate tool name: ${tool.name}`)
      changed.add(tool.name)
      continue
    }
    current.set(tool.name, tool)
  }

  for (const [name, digest] of pins.tools) {
    const tool = current.get(name)
    if (!tool) {
      reasons.push(`tool removed: ${name}`)
      changed.add(name)
      continue
    }
    const next = digestTool(tool)
    if (next !== digest) {
      reasons.push(`tool changed: ${name} ${digest} -> ${next}`)
      changed.add(name)
    }
  }

  for (const name of current.keys()) {
    if (!pins.tools.has(name)) {
      reasons.push(`tool added: ${name}`)
      changed.add(name)
    }
  }

  if (catalogDigest(tools) !== pins.catalog) {
    reasons.push('catalog digest changed')
  }

  return { ok: reasons.length === 0, reasons, changed: [...changed].sort() }
}

/**
 * Assert that the requested tool is still exactly the pinned tool.
 *
 * A host can call this with the schema it is about to use for validation; an
 * absent pin is a failure, never an implicit trust decision.
 */
export function assertToolPinned(pins: ToolPins, tool: McpTool): PinVerdict {
  const expected = pins.tools.get(tool.name)
  if (expected === undefined) {
    return { ok: false, reasons: [`tool not pinned: ${tool.name}`], changed: [tool.name] }
  }
  const actual = digestTool(tool)
  if (actual !== expected) {
    return {
      ok: false,
      reasons: [`tool changed: ${tool.name} ${expected} -> ${actual}`],
      changed: [tool.name],
    }
  }
  return { ok: true, reasons: [], changed: [] }
}
