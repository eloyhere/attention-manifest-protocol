#!/usr/bin/env node
/**
 * AMP schema validator.
 *
 * A deliberately small JSON Schema (draft 2020-12 subset) checker so that
 * `docs/schemas/*.json` are executable contracts, not decoration.
 *
 * Supported keywords: $ref (internal + relative file), type, const, enum,
 * required, properties, additionalProperties, items, minItems, maxItems,
 * minLength, pattern, format (date-time), minimum, maximum,
 * oneOf, anyOf, allOf.
 *
 * Usage: node tools/validate.mjs [--quiet]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaDir = join(root, 'docs', 'schemas')
const examplesDir = join(root, 'docs', 'examples')

const cache = new Map()
function load(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const json = JSON.parse(readFileSync(absPath, 'utf8'))
  cache.set(absPath, json)
  return json
}

function resolveRef(ref, baseFile) {
  const [filePart, pointerPart] = ref.split('#')
  const targetFile = filePart ? resolve(dirname(baseFile), filePart) : baseFile
  const target = load(targetFile)
  let node = target
  if (pointerPart) {
    const parts = pointerPart
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))
    for (const p of parts) node = node == null ? undefined : node[p]
  }
  return { node, file: targetFile }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function checkType(expected, data) {
  if (Array.isArray(expected)) return expected.some((t) => checkType(t, data))
  switch (expected) {
    case 'object': return isObject(data)
    case 'array': return Array.isArray(data)
    case 'string': return typeof data === 'string'
    case 'number': return typeof data === 'number' && Number.isFinite(data)
    case 'integer': return typeof data === 'number' && Number.isInteger(data)
    case 'boolean': return typeof data === 'boolean'
    case 'null': return data === null
    default: return true
  }
}

/**
 * @param {any} schema
 * @param {any} data
 * @param {string} baseFile absolute path of the schema file owning `schema`
 * @param {string} path JSON pointer-ish path for messages
 * @param {string[]} errors
 * @param {number} depth
 */
function validate(schema, data, baseFile, path, errors, depth = 0) {
  if (depth > 80 || schema == null || typeof schema !== 'object') return

  if (schema.$ref) {
    const { node, file } = resolveRef(schema.$ref, baseFile)
    if (node === undefined) {
      errors.push(`${path}: unresolved $ref ${schema.$ref}`)
      return
    }
    validate(node, data, file, path, errors, depth + 1)
    return
  }

  if (schema.oneOf) {
    const branchErrors = []
    let matched = 0
    for (const branch of schema.oneOf) {
      const errs = []
      validate(branch, data, baseFile, path, errs, depth + 1)
      if (errs.length === 0) matched++
      else branchErrors.push(errs)
    }
    if (matched === 0) {
      const shortest = branchErrors.sort((a, b) => a.length - b.length)[0] ?? []
      errors.push(`${path}: does not match any oneOf branch`)
      for (const e of shortest.slice(0, 4)) errors.push(`  ${e}`)
    } else if (matched > 1) {
      errors.push(`${path}: matches ${matched} oneOf branches (must be exactly one)`)
    }
    return
  }

  if (schema.anyOf) {
    const ok = schema.anyOf.some((branch) => {
      const errs = []
      validate(branch, data, baseFile, path, errs, depth + 1)
      return errs.length === 0
    })
    if (!ok) errors.push(`${path}: does not match any anyOf branch`)
    return
  }

  if (schema.allOf) {
    for (const branch of schema.allOf) validate(branch, data, baseFile, path, errors, depth + 1)
    return
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && data !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`)
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: ${JSON.stringify(data)} is not in enum [${schema.enum.join(', ')}]`)
  }
  if (schema.type && !checkType(schema.type, data)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(data)}`)
    return
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${path}: ${data} < minimum ${schema.minimum}`)
    if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${path}: ${data} > maximum ${schema.maximum}`)
  }

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${path}: too short (minLength ${schema.minLength})`)
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${path}: does not match pattern ${schema.pattern}`)
    if (schema.format === 'date-time' && !DATE_TIME.test(data)) errors.push(`${path}: invalid date-time ${data}`)
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push(`${path}: allows at most ${schema.maxItems} items`)
    if (schema.items) data.forEach((item, i) => validate(schema.items, item, baseFile, `${path}[${i}]`, errors, depth + 1))
    return
  }

  if (isObject(data)) {
    if (schema.required) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) errors.push(`${path}: missing required "${key}"`)
      }
    }
    const props = schema.properties ?? {}
    for (const [key, value] of Object.entries(data)) {
      if (props[key]) {
        validate(props[key], value, baseFile, `${path}.${key}`, errors, depth + 1)
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`)
      }
    }
  }
}

const KIND_TO_SCHEMA = {
  manifest: 'manifest.schema.json',
  frame: 'frame.schema.json',
  claim: 'epistemic.schema.json',
  hypothesis: 'epistemic.schema.json',
  unknown: 'epistemic.schema.json',
  concept: 'concept.schema.json',
  goal: 'plan.schema.json',
  process: 'plan.schema.json',
  plan: 'plan.schema.json',
  'other-model': 'social.schema.json',
  'common-ground': 'social.schema.json',
  'attention-request': 'social.schema.json',
  receipt: 'receipt.schema.json',
  event: 'receipt.schema.json',
  message: 'message.schema.json',
  call: 'verb.schema.json',
  bundle: 'federation.schema.json',
  attestation: 'federation.schema.json',
  'ledger-snapshot': 'ledger-snapshot.schema.json',
  delegation: 'collaboration.schema.json',
  lease: 'collaboration.schema.json',
  'result-contract': 'collaboration.schema.json',
  'team-manifest': 'team.schema.json',
  'commitment-record': 'team.schema.json',
}

function fail(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`)
  process.exitCode = 1
}

function main() {
  if (!existsSync(schemaDir)) return fail(`missing schema directory: ${schemaDir}`)

  // 1. every schema must parse
  for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.json'))) {
    try {
      load(join(schemaDir, file))
    } catch (err) {
      fail(`schema ${file} is not valid JSON: ${err.message}`)
    }
  }

  if (!existsSync(examplesDir)) {
    console.log('no examples directory; schemas parsed only')
    return
  }

  // 2. every example must validate against the schema for its kind
  let checked = 0
  for (const file of readdirSync(examplesDir).filter((f) => f.endsWith('.json')).sort()) {
    const abs = join(examplesDir, file)
    let doc
    try {
      doc = JSON.parse(readFileSync(abs, 'utf8'))
    } catch (err) {
      fail(`${file}: invalid JSON (${err.message})`)
      continue
    }

    const items = Array.isArray(doc) ? doc : [doc]
    items.forEach((item, index) => {
      const label = Array.isArray(doc) ? `${file}[${index}]` : file
      const kind = item?.kind
      const schemaName = KIND_TO_SCHEMA[kind]
      if (!schemaName) {
        fail(`${label}: unknown kind ${JSON.stringify(kind)}`)
        return
      }
      const schemaPath = join(schemaDir, schemaName)
      const errors = []
      validate(load(schemaPath), item, schemaPath, '$', errors)
      if (errors.length) {
        fail(`${label} (${schemaName})`)
        for (const e of errors.slice(0, 12)) console.error(`    ${e}`)
        if (errors.length > 12) console.error(`    … ${errors.length - 12} more`)
      } else {
        checked++
        console.log(`\x1b[32m✓\x1b[0m ${label}  (${schemaName})`)
      }
    })
  }

  console.log(`\n${checked} example object(s) validated`)
}

main()
