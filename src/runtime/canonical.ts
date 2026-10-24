import { sha256Hex } from './sha256.ts'

/**
 * Canonical JSON (RFC 8785 spirit: sorted keys, no whitespace).
 * Everything that gets signed or digested must go through this first.
 */
export function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`
}

export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonical(value))}`
}
