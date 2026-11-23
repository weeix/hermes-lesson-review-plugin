import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_SRC = join(HERE, '..', '..', 'desktop', 'plugin.js')
// What a desktop plugin may import (the host's loader contract).
const ALLOWED = ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime']

function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`expected exactly one ${from} in plugin.js`)
  return text.replace(from, to)
}

// Append test-only exports to the copy so the shipped plugin keeps only its SDK entry point.
export async function loadPluginCopy(name, { sdk, react = null, extra = '' }) {
  const src = readFileSync(PLUGIN_SRC, 'utf8')
  const specifiers = [...src.matchAll(/^import .* from '([^']+)'$/gm)].map(m => m[1]).sort()
  if (JSON.stringify(specifiers) !== JSON.stringify(ALLOWED)) {
    throw new Error(`plugin imports ${specifiers.join(', ')}; only ${ALLOWED.join(', ')} are allowed`)
  }
  let copy = replaceOnce(src, "from '@hermes/plugin-sdk'", `from '../${sdk}'`)
  if (react) copy = replaceOnce(copy, "from 'react'\n", `from '../${react}'\n`)
  mkdirSync(join(HERE, '.generated'), { recursive: true })
  writeFileSync(join(HERE, '.generated', name), copy + extra)
  return import(`./.generated/${name}`)
}

export async function setupDom() {
  const { JSDOM } = await import('jsdom')
  const w = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true }).window
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'NodeFilter', 'Event',
    'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'MutationObserver']) {
    Object.defineProperty(globalThis, name, { value: w[name], configurable: true, writable: true })
  }
  w.HTMLElement.prototype.scrollIntoView ||= () => {}
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return w
}


export function checker(label) {
  let passed = 0
  let failed = 0
  return {
    check(name, ok, detail = '') {
      if (ok) passed++
      else failed++
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`)
    },
    finish() {
      console.log(`\n${passed + failed} ${label} checks, ${passed} passed, ${failed} failed`)
      process.exit(failed ? 1 : 0)
    }
  }
}

export function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// The desktop bridge's error shape: "<status>: <body>" with a numeric statusCode.
export function httpError(status, body) {
  return Object.assign(new Error(`${status}: ${body}`), { statusCode: status })
}

export const decisionsDisabledError = () => httpError(403, '{"detail":"approve/reject are disabled for this profile"}')

// A ready memory preview whose content and expect hash carry `sha`, so a test can tell versions apart.
export const memoryPreview = (id, sha = id) => ({
  kind: 'memory', id, origin: 'foreground', action: 'add', status: 'ready', reason: null,
  decisions_enabled: true, summary: 'Memory add', is_batch: false, op_count: 1,
  ops: [{ index: 1, action: 'add', subject: 'user', fields: { content: `sample ${sha}` }, diff: null }],
  expect: { review_kind: 'memory', review_id: id, record_sha256: sha, profile: 'default' }
})
