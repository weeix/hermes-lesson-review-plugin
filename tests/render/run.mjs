// Static render tests use route responses, not fixtures embedded in the generated plugin copy.
// To exercise a live backend instead of a snapshot, set WR_BASE and WR_TOKEN.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'
import { decisionsDisabledError, httpError, loadPluginCopy } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.WR_BASE || 'http://127.0.0.1:9431'
const TOKEN = process.env.WR_TOKEN || ''
const SNAPSHOT_FILE = process.env.WR_SNAPSHOT || ''
const SNAPSHOT = SNAPSHOT_FILE ? JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) : null
const PROFILE = 'default-test'
if (!SNAPSHOT && !TOKEN) {
  console.error('WR_TOKEN (live backend) or WR_SNAPSHOT (make-snapshot.py output) is required')
  process.exit(2)
}

async function getJson(path) {
  if (SNAPSHOT) {
    if (!(path in SNAPSHOT)) throw new Error(`snapshot has no ${path}; regenerate it with make-snapshot.py`)
    return structuredClone(SNAPSHOT[path])
  }
  const r = await fetch(BASE + path, { headers: { 'X-Hermes-Session-Token': TOKEN } })
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`)
  return r.json()
}

// ---- 1. data from the backend (the same calls the pane makes) ----
const all = await getJson('/api/plugins/lesson-review/pending?kind=all')
const batch = all.items.find(i => i.is_batch && i.kind === 'skills')
const memSingle = all.items.find(i => i.kind === 'memory' && !i.is_batch)
if (!batch || !memSingle) throw new Error('need one skills batch and one single memory record staged in the backend')
const live = {
  all,
  batchPreview: await getJson(`/api/plugins/lesson-review/pending/skills/${batch.id}`),
  singlePreview: await getJson(`/api/plugins/lesson-review/pending/memory/${memSingle.id}`),
}
const key = (...parts) => JSON.stringify(['lesson-review', ...parts])
// The pane opens on the All filter, so only that list is read in these static renders.
// Query keys: profile, gateway activation, connection id (the stub's host reports 'local'), then the rest.
const listKey = key('pending', PROFILE, 1, 'local', 'all', 1)
const batchKey = key('preview', PROFILE, 1, 'local', all.scope, 'skills', batch.id)
const singleKey = key('preview', PROFILE, 1, 'local', all.scope, 'memory', memSingle.id)

function okQueries() {
  return new Map([
    [listKey, { data: live.all }],
    [batchKey, { data: live.batchPreview }],
    [singleKey, { data: live.singlePreview }],
  ])
}

// A failed list keeps the data it had before (react-query's behaviour).
function failedListQueries(error, stale = live.all) {
  return new Map([[listKey, { error, stale }]])
}

const PLUGIN_OFF_BODY = '{"detail":"Plugin not found","note":"RAW-ERROR-BODY"}'

const emptyData = { scope: 'empty', kind: 'all', page: 1, page_size: 25, total: 0,
  counts: { memory: 0, skills: 0, total: 0 }, gates: live.all.gates, items: [] }

// ---- 2. generated copy of the plugin, with the stubbed SDK and react ----
// Test hooks: the outcome mapping and the footer, reachable from the generated copy only.
const generated = await loadPluginCopy('plugin.mjs', {
  sdk: 'sdk-stub.mjs', react: 'react-shim.mjs', extra: '\nexport const __test = { decisionOutcome, ReviewFooter, ReviewBody }\n'
})
const plugin = generated.default
const hooks = generated.__test

// ---- 3. register() with a recording ctx ----
function register(pluginDef) {
  const contributions = []
  const ctx = {
    source: 'plugin:' + pluginDef.id,
    register(c) { contributions.push(c); return () => {} },
    rest: path => getJson('/api/plugins/lesson-review' + path),
  }
  pluginDef.register(ctx)
  return contributions
}

// Renders the pane and the badge for one scenario. `preselect` is the record the review dialog opens on.
function renderScenario(queries, preselect = null) {
  globalThis.__WR_QUERIES__ = queries
  globalThis.__WR_PROFILE__ = PROFILE
  globalThis.__WR_PRESELECT__ = preselect && { scope: all.scope, ...preselect }
  try {
    const contributions = register(plugin)
    const pane = contributions.find(c => c.area === 'panes')
    const badge = contributions.find(c => c.area === 'statusBar.right')
    return { paneHtml: renderToStaticMarkup(pane.render()), badgeHtml: renderToStaticMarkup(badge.render()) }
  } finally {
    globalThis.__WR_PRESELECT__ = null
  }
}

const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const checks = []
const check = (name, cond, extra = '') => checks.push([cond ? 'PASS' : 'FAIL', name, extra])
const rowCount = html => (html.match(/data-wr-row="/g) || []).length
const OFF_TEXT = 'Lesson review is turned off on this Hermes. Turn it on in Capabilities → Plugins.'

// ---- 4. scenario: live data, one record open in the review dialog ----
{
  const contributions = register(plugin)
  const pane = contributions.find(c => c.area === 'panes')
  check('register: pane asks to dock as a tab in the File Browser zone',
    JSON.stringify(pane?.data?.dock) === JSON.stringify({ pane: 'files', pos: 'center' }), JSON.stringify(pane?.data))
  check('register: badge contribution in statusBar.right', Boolean(contributions.find(c => c.area === 'statusBar.right')))
  const keybinds = contributions.filter(c => c.area === 'keybinds').map(c => c.data)
  const palette = contributions.filter(c => c.area === 'palette').map(c => c.data)
  check('register: Show and Refresh keybind actions, both unbound by default',
    JSON.stringify(keybinds.map(k => [k.id, k.defaults]).sort())
      === JSON.stringify([['lesson-review.refresh', []], ['lesson-review.showPane', []]])
    && keybinds.every(k => typeof k.run === 'function' && k.label), JSON.stringify(keybinds))
  check('register: a palette row per action, naming it for the chord hint',
    JSON.stringify(palette.map(p => p.action).sort()) === JSON.stringify(['lesson-review.refresh', 'lesson-review.showPane'])
    && palette.every(p => p.label && typeof p.run === 'function' && typeof p.detail === 'function'),
    JSON.stringify(palette.map(p => p.id)))
  check('plugin id, and off until the user turns it on', plugin.id === 'lesson-review' && plugin.defaultEnabled === false)
  const yamlName = readFileSync(join(HERE, '..', '..', 'plugin.yaml'), 'utf8').match(/^name:\s*(\S+)\s*$/m)?.[1]
  check('desktop name equals the server package name (plugin.yaml)', plugin.name === yamlName && yamlName === 'lesson-review',
    `${plugin.name} / ${yamlName}`)

  const { paneHtml, badgeHtml } = renderScenario(okQueries(), { kind: 'skills', id: batch.id, created_at: batch.created_at })
  check('badge shows total count', /pending writes: \d+/.test(badgeHtml), text(badgeHtml))
  check('badge total matches backend', badgeHtml.includes(`pending writes: ${all.counts.total}`))
  check('pane title', /Lesson review/.test(paneHtml))
  check('pane counts line', paneHtml.includes(`memory ${all.counts.memory} · skills ${all.counts.skills}`))
  check('gates line shows the backend gate states', paneHtml.includes('write_approval: memory on · skills on'), text(paneHtml).slice(0, 200))
  check('list rows rendered (one per item, in order)', JSON.stringify([...paneHtml.matchAll(/data-wr-row="([^"]+)"/g)].map(m => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">")))
    === JSON.stringify(all.items.map(i => `${i.kind}:${i.id}`)))
  check('batch row labelled', /batch of \d+/.test(paneHtml))
  check('dialog: batch view shows op breakdown', /op 2 · patch/.test(paneHtml) && /op 3 · write_file/.test(paneHtml))
  const create = live.batchPreview.ops[0]
  const content = create.fields.content
  check('dialog: create renders the full SKILL.md as plain text',
    create.diff === null && content && paneHtml.includes(`>${renderToStaticMarkup(content)}</div>`))
  const dom = new JSDOM(paneHtml)
  const diffLines = [...dom.window.document.querySelectorAll('[data-wr-diff-line]')]
  const patchDiff = live.batchPreview.ops[1].diff
  check('dialog: the patch op shows its diff text', typeof patchDiff === 'string'
    && patchDiff.split('\n').filter(line => /^[+-][^+-]/.test(line)).every(line => diffLines.some(row => row.textContent === line)), JSON.stringify(patchDiff))
  const added = diffLines.find(row => row.dataset.wrDiffLine === 'add' && row.textContent === '+Use tags.')
  const addedStyle = added?.getAttribute('style') || ''
  check('dialog: an added line is green (the host diff colour)',
    addedStyle.includes('var(--ui-diff-add-background') && addedStyle.includes('var(--ui-diff-add-foreground'))
  dom.window.close()
  for (const label of ['Approve', 'Reject']) {
    const tag = paneHtml.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] || ''
    check(`dialog: ${label} has the disabled attribute`, /\sdisabled=""/.test(tag), tag.slice(0, 160))
    check(`dialog: ${label} is dimmed with a not-allowed cursor`,
      /opacity:0\.45/.test(tag) && /cursor:not-allowed/.test(tag), tag.slice(0, 160))
    check(`dialog: ${label} is not the primary (blue) variant`,
      /data-variant="secondary"/.test(tag) && !/data-variant="default"/.test(tag), tag.slice(0, 160))
  }
}

{
  const queries = okQueries()
  const selected = { kind: 'skills', id: batch.id, created_at: batch.created_at }
  const preview = { ...live.batchPreview, decisions_enabled: true, expect: { review_id: batch.id } }
  for (const status of ['ready', 'stale']) {
    queries.set(batchKey, { data: { ...preview, status, reason: status === 'stale' ? 'Stale target.' : null } })
    const { paneHtml } = renderScenario(queries, selected)
    const approve = paneHtml.match(/<button[^>]*>Approve<\/button>/)?.[0] || ''
    const reject = paneHtml.match(/<button[^>]*>Reject<\/button>/)?.[0] || ''
    check(`${status}: Approve available only for ready`, Boolean(approve) && /\sdisabled=""/.test(approve) === (status === 'stale'))
    check(`${status}: Reject stays available`, Boolean(reject) && !/\sdisabled=""/.test(reject))
  }
}

// ---- 5. failure scenarios: no counts, rows or gates from before the failure; a friendly message ----
// Each error body carries RAW_MARK, which may show in a tooltip but never as visible text.
const RAW_MARK = 'RAW-ERROR-BODY'
function failureChecks(name, queries, { message, badgeTitle }) {
  const { paneHtml, badgeHtml } = renderScenario(queries)
  const visible = text(paneHtml)
  check(`${name}: pane shows "${message}"`, visible.includes(message), visible.slice(0, 140))
  check(`${name}: no stale counts in the header`, !/memory \d+ · skills \d+/.test(visible), visible.slice(0, 140))
  check(`${name}: no stale rows`, rowCount(paneHtml) === 0)
  check(`${name}: no stale gates`, !visible.includes('write_approval:'))
  check(`${name}: raw error text not visible`, !visible.includes(RAW_MARK) && !visible.includes('Plugin not found'))
  check(`${name}: Retry still offered`, paneHtml.includes('>Retry<'))
  check(`${name}: badge says unavailable`, badgeHtml.includes('pending writes: –'), text(badgeHtml))
  check(`${name}: badge does not show the stale total`, !badgeHtml.includes(`pending writes: ${all.counts.total}`))
  check(`${name}: badge title explains`, badgeHtml.includes(`title="${badgeTitle}"`), badgeTitle)
}

failureChecks('plugin off (statusCode)', failedListQueries(httpError(404, PLUGIN_OFF_BODY)),
  { message: OFF_TEXT, badgeTitle: OFF_TEXT })
failureChecks('plugin off (message only)', failedListQueries(new Error(`404: ${PLUGIN_OFF_BODY}`)),
  { message: OFF_TEXT, badgeTitle: OFF_TEXT })
failureChecks('network down', failedListQueries(new TypeError('fetch failed RAW-ERROR-BODY')),
  { message: 'Could not reach Hermes.', badgeTitle: 'Could not reach Hermes.' })
failureChecks('server error 503', failedListQueries(httpError(503, 'Service Unavailable RAW-ERROR-BODY')),
  { message: 'Could not reach Hermes.', badgeTitle: 'Could not reach Hermes.' })
failureChecks('store refused (409)', failedListQueries(httpError(409, '{"detail":"store refused RAW-ERROR-BODY"}')),
  { message: 'Hermes could not access this profile’s pending store.',
    badgeTitle: 'Hermes could not access this profile’s pending store.' })
failureChecks('session refused (401)', failedListQueries(httpError(401, 'Unauthorized RAW-ERROR-BODY')),
  { message: 'Hermes refused this session (HTTP 401). Reconnect, then Retry.',
    badgeTitle: 'Hermes refused this session (HTTP 401). Reconnect, then Retry.' })

// Native Desktop: Electron's IPC bridge passes only the message, wrapped, and drops statusCode
// (apps/desktop/src/lib/gateway-rpc.ts matches the same form).
const ipcError = (status, body) => new Error(`Error invoking remote method 'hermes:api': Error: ${status}: ${body}`)
failureChecks('IPC: plugin off', failedListQueries(ipcError(404, PLUGIN_OFF_BODY)), { message: OFF_TEXT, badgeTitle: OFF_TEXT })
failureChecks('IPC: store refused (409)', failedListQueries(ipcError(409, '{"detail":"store refused RAW-ERROR-BODY"}')),
  { message: 'Hermes could not access this profile’s pending store.',
    badgeTitle: 'Hermes could not access this profile’s pending store.' })
failureChecks('IPC: session refused (401)', failedListQueries(ipcError(401, 'Unauthorized RAW-ERROR-BODY')),
  { message: 'Hermes refused this session (HTTP 401). Reconnect, then Retry.',
    badgeTitle: 'Hermes refused this session (HTTP 401). Reconnect, then Retry.' })
failureChecks('IPC: no Write Review API (503)',
  failedListQueries(ipcError(503, '{"detail":"This Hermes build does not provide the Write Review API. RAW-ERROR-BODY"}')),
  { message: 'Lesson review needs a Hermes backend with the Write Review API. See the plugin README.',
    badgeTitle: 'Lesson review needs a Hermes backend with the Write Review API. See the plugin README.' })
failureChecks('IPC: network down (no status)', failedListQueries(new Error("Error invoking remote method 'hermes:api': Error: connect ECONNREFUSED RAW-ERROR-BODY")),
  { message: 'Could not reach Hermes.', badgeTitle: 'Could not reach Hermes.' })

// ---- 6. the other states must stay distinct from a failure ----
{
  const { paneHtml, badgeHtml } = renderScenario(new Map([[listKey, { data: emptyData }]]))
  check('empty queue: "No pending writes" and zero counts', text(paneHtml).includes('No pending writes in this profile.')
    && paneHtml.includes('memory 0 · skills 0'))
  check('empty queue: badge shows 0', badgeHtml.includes('pending writes: 0'))
  check('empty queue: no failure text', !text(paneHtml).includes('Could not reach Hermes') && !paneHtml.includes('>Retry<'))
}
{
  const { paneHtml, badgeHtml } = renderScenario(new Map([[listKey, { pending: true }]]))
  check('loading: "Loading pending writes…", badge unavailable until data', text(paneHtml).includes('Loading pending writes')
    && badgeHtml.includes('pending writes: –'))
}
// ---- 7. review dialog: placement, decision gating, outcomes ----
const DIALOG_OPEN = 'data-slot="dialog-content"'
const DIALOG_TITLE = 'Review pending write'
const inDialog = html => (html.indexOf(DIALOG_OPEN) < 0 ? '' : html.slice(html.indexOf(DIALOG_OPEN)))
const buttonTag = (html, label) => html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] || ''
const isDisabled = (html, label) => /\sdisabled=""/.test(buttonTag(html, label))
const isEnabled = (html, label) => buttonTag(html, label) !== '' && !isDisabled(html, label)
// The title of the span that wraps a decision button (a disabled button takes no pointer events).
const wrapperTitle = (html, label) => html.match(new RegExp(`<span[^>]*title="([^"]*)"[^>]*><button[^>]*>${label}</button>`))?.[1] ?? null
const { decisionOutcome, ReviewFooter, ReviewBody } = hooks
const READY = { decisions_enabled: true, expect: { review_id: 'x' }, status: 'ready', reason: null }
const IDLE = { busy: false, notice: null, settled: false, stale: false }
const footer = (rec, decision) => renderToStaticMarkup(ReviewFooter({ rec, decision, onApprove() {}, onReject() {}, onClose() {}, onPreviewAgain() {} }))
const DECISION_TEXT = 'Decisions are turned off for this profile (read-only).'
const variant = (html, label) => buttonTag(html, label).match(/data-variant="(\w+)"/)?.[1] ?? null
const dimmed = (html, label) => /opacity:0\.45;cursor:not-allowed/.test(buttonTag(html, label))

{
  const { paneHtml } = renderScenario(okQueries(), null)
  check('dialog: nothing selected, no dialog', !paneHtml.includes(DIALOG_OPEN) && !paneHtml.includes(DIALOG_TITLE) && !paneHtml.includes('>Approve<'))
  check('dialog: list still rendered with nothing selected', rowCount(paneHtml) === all.items.length)
}
{
  const { paneHtml } = renderScenario(okQueries(), { kind: 'skills', id: batch.id, created_at: batch.created_at })
  const count = paneHtml.split(DIALOG_OPEN).length - 1
  check('dialog: one dialog for the selected record', count === 1, `${count} dialogs`)
  check('dialog: list stays rendered behind it', rowCount(paneHtml) === all.items.length)
  const dlg = inDialog(paneHtml)
  check('dialog: titled Review pending write', dlg.includes(DIALOG_TITLE))
  check('dialog: carries the record id, age and per-op preview',
    dlg.includes(`>${batch.id}</span>`) && /<span>· \d+[smhd] ago<\/span>/.test(dlg) && /op 2 · patch/.test(dlg))
  // The record's own time wins; the list row's time fills in when the preview has none (core sends null).
  const idLine = (createdAt, fallbackCreatedAt) => renderToStaticMarkup(ReviewBody({
    rec: { ...live.batchPreview, created_at: createdAt }, fallbackCreatedAt }))
  const now = Date.now() / 1000
  const ownTime = idLine(now - 7200, now - 3 * 86400)
  check('dialog age: the preview\'s created_at is shown, not the row\'s',
    ownTime.includes('>· 2h ago</span>') && !ownTime.includes('3d ago'))
  check('dialog id line: the id, then the Copy ID icon, then the age',
    new RegExp(`>${batch.id}</span><button[^>]*data-wr-copy="id"[^>]*aria-label="Copy ID"[^>]*><svg[\\s\\S]*?</svg></button><span>· 2h ago</span>`).test(ownTime))
  for (const missing of [undefined, null]) {
    const fromRow = idLine(missing, now - 3 * 86400)
    check(`dialog age: created_at ${missing} falls back to the list row's time`, fromRow.includes('>· 3d ago</span>'))
    const none = idLine(missing, undefined)
    check(`dialog age: created_at ${missing} and no row time shows the id alone, no separator`,
      none.includes(`>${batch.id}</span>`) && !none.includes('>· '))
  }
  for (const label of ['Approve', 'Reject', 'Close']) check(`dialog: footer has ${label}`, buttonTag(dlg, label) !== '')
  check('dialog: width and max-width are inline', paneHtml.includes('width:min(860px, calc(100vw - 2rem))') && paneHtml.includes('max-width:calc(100vw - 2rem)'))
}
{
  // A removed frontmatter line inside a hunk is `----`: red, not a header.
  const diff = '--- before\n+++ after\n@@ -1,3 +1,3 @@\n----\n-old line\n+new line\n context'
  const ops = live.batchPreview.ops.map((op, i) => (i === 1 ? { ...op, diff } : op))
  const queries = okQueries()
  queries.set(batchKey, { data: { ...live.batchPreview, ops } })
  const { paneHtml } = renderScenario(queries, { kind: 'skills', id: batch.id, created_at: batch.created_at })
  const dom = new JSDOM(paneHtml)
  const kinds = Object.fromEntries([...dom.window.document.querySelectorAll('[data-wr-diff-line]')].map(row => [row.textContent, row.dataset.wrDiffLine]))
  check('diff colours: removed lines red, added green, headers muted, context plain',
    kinds['----'] === 'remove' && kinds['-old line'] === 'remove' && kinds['+new line'] === 'add'
    && kinds['--- before'] === 'meta' && kinds['+++ after'] === 'meta' && kinds[' context'] === 'context', JSON.stringify(kinds))
  check('diff colours: removed lines use the host remove colour', paneHtml.includes('var(--ui-diff-remove-foreground'))
  dom.window.close()
}
{
  const longPrefix = `${'a'.repeat(1100)} `
  const manyWords = 'a '.repeat(130)
  const beforeHeader = '--- a/skills/shared-notes-before.txt'
  const afterHeader = '+++ b/skills/shared-notes-after.txt'
  const noNewline = '\\ No newline at end of file'
  const diff = [
    '--- before', '+++ after', '@@ -1,8 +1,9 @@',
    '-เก็บบันทึกไว้ 7 วัน', '+เก็บบันทึกไว้ 30 วัน',
    ' context',
    '-Keep short notes for 7 days.', '-Send a daily summary.',
    '+Keep brief notes for 30 days.', '+Send a weekly summary.',
    ' context',
    '-Keep the same rule today.', '+An extra rule.', '+Keep the same rule tomorrow.',
    ' context',
    '-Go upstairs now.', '+Come downstairs later.',
    '@@ -13 +14 @@', `-${longPrefix}old`, `+${longPrefix}new`,
    '@@ -15 +16 @@', `-${manyWords}old`, `+${manyWords}new`,
    '@@ -16 +17 @@', '-Keep cats dogs', '+Keep dogs cats',
    '@@ -17 +18 @@', '-## Visual preview (for the user, not a test)', '+## Inline diffs',
    '@@ -18 +19 @@', '-A key:value changed', '+A key:value, changed',
    '@@ -19 +20,0 @@', '-Retain logs for seven days.',
    '@@ -20 +21,2 @@', '-Use two lines here.', '+Use two', '+lines here.',
    '@@ -22 +23 @@', '-  keep    these words', '+  keep these  words  ',
    '@@ -24,0 +24 @@', '+Retain logs for thirty days.',
    'diff --git a/skills/shared-notes-before.txt b/skills/shared-notes-after.txt', beforeHeader, afterHeader,
    '@@ -1 +1 @@', '-Second file, old.', noNewline, '+Second file, new.'
  ].join('\n')
  const dom = new JSDOM()
  function diffRows(diff) {
    const queries = okQueries()
    const ops = live.batchPreview.ops.map((op, i) => (i === 1 ? { ...op, diff } : op))
    queries.set(batchKey, { data: { ...live.batchPreview, ops } })
    const { paneHtml } = renderScenario(queries, { kind: 'skills', id: batch.id, created_at: batch.created_at })
    const doc = new dom.window.DOMParser().parseFromString(paneHtml, 'text/html')
    return new Map([...doc.querySelectorAll('[data-wr-diff-line]')].map(row => [row.textContent, row]))
  }
  const rows = diffRows(diff)
  const highlights = row => [...row.querySelectorAll('[data-wr-diff-change]')]
  for (const [name, lines] of [
    ['only the number changes in Thai', [['-เก็บบันทึกไว้ 7 วัน', ['7']], ['+เก็บบันทึกไว้ 30 วัน', ['30']]]],
    ['separate changes within adjacent replacement lines', [
      ['-Keep short notes for 7 days.', ['short', '7']], ['+Keep brief notes for 30 days.', ['brief', '30']],
      ['-Send a daily summary.', ['daily']], ['+Send a weekly summary.', ['weekly']]
    ]],
    ['a no-newline marker does not interrupt a replacement', [
      ['-Second file, old.', ['old.']], ['+Second file, new.', ['new.']]
    ]],
    ['an entire new heading title leaves its Markdown prefix plain', [
      ['-## Visual preview (for the user, not a test)', ['Visual preview (for the user, not a test)']],
      ['+## Inline diffs', ['Inline diffs']]
    ]],
    ['punctuation is part of the whitespace-delimited word', [['-A key:value changed', ['key:value']], ['+A key:value, changed', ['key:value,']]]],
    ['gaps do not prevent later words from matching', [
      ['-Keep the same rule today.', ['today.']], ['+An extra rule.', ['An extra rule.']], ['+Keep the same rule tomorrow.', ['tomorrow.']]
    ]],
    ['no shared words marks the whole replacement text', [['-Go upstairs now.', ['Go upstairs now.']], ['+Come downstairs later.', ['Come downstairs later.']]]],
    ['reordered words', [['-Keep cats dogs', ['cats']], ['+Keep dogs cats', ['cats']]]],
    ['unpaired changes in different hunks stay distinct', [['-Retain logs for seven days.', ['Retain logs for seven days.']], ['+Retain logs for thirty days.', ['Retain logs for thirty days.']]]]
  ]) {
    check(`diff word emphasis: ${name}`, lines.every(([line, words]) => rows.has(line)
      && JSON.stringify(highlights(rows.get(line)).map(mark => mark.textContent)) === JSON.stringify(words)))
  }
  for (const [name, lines] of [
    ['very long lines', [`-${longPrefix}old`, `+${longPrefix}new`]],
    ['lines with many tokens', [`-${manyWords}old`, `+${manyWords}new`]],
    ['soft line breaks between the same words', ['-Use two lines here.', '+Use two', '+lines here.']],
    ['changes in spacing alone', ['-  keep    these words', '+  keep these  words  ']]
  ]) {
    check(`diff word emphasis: ${name} keep line-only colouring`, lines.every(line => rows.has(line)
      && highlights(rows.get(line)).length === 0))
  }
  check('diff word emphasis: later file headers stay metadata', [beforeHeader, afterHeader].every(line =>
    rows.get(line)?.dataset.wrDiffLine === 'meta' && highlights(rows.get(line)).length === 0))
  check('diff: the no-newline marker stays visible without change colouring', rows.get(noNewline)?.dataset.wrDiffLine === 'meta')
  const largeRows = diffRows(`@@ -1,2 +1,2 @@\n ${'a'.repeat(100_000)}\n-Keep for 7 days.\n+Keep for 30 days.`)
  check('diff word emphasis: oversized previews keep line-only colouring', ['-Keep for 7 days.', '+Keep for 30 days.']
    .every(line => largeRows.has(line) && highlights(largeRows.get(line)).length === 0))
  dom.window.close()
}

// Footer gating: why each decision button is disabled, on the wrapper's tooltip.
{
  const off = footer({ ...READY, decisions_enabled: false }, IDLE)
  check('gate off: Approve and Reject disabled, explained on the wrapper', isDisabled(off, 'Approve') && isDisabled(off, 'Reject') && wrapperTitle(off, 'Approve') === DECISION_TEXT && wrapperTitle(off, 'Reject') === DECISION_TEXT)
  check('gate off: the reason is also visible as text', off.includes(DECISION_TEXT))
  check('gate off: both buttons neutral and dimmed', variant(off, 'Approve') === 'secondary' && variant(off, 'Reject') === 'secondary'
    && dimmed(off, 'Approve') && dimmed(off, 'Reject'))
  const busy = footer(READY, { ...IDLE, busy: true })
  check('busy: both decisions disabled (in-progress reason), Close disabled', isDisabled(busy, 'Approve') && isDisabled(busy, 'Reject') && wrapperTitle(busy, 'Reject') === 'A decision is in progress.' && isDisabled(busy, 'Close'))
  const ok = footer(READY, IDLE)
  check('ready and idle: Approve, Reject and Close enabled, no reason', isEnabled(ok, 'Approve') && isEnabled(ok, 'Reject') && isEnabled(ok, 'Close') && wrapperTitle(ok, 'Approve') === null)
  check('ready and idle: Approve is the primary (default) variant, Reject neutral, neither dimmed',
    variant(ok, 'Approve') === 'default' && variant(ok, 'Reject') === 'secondary' && !dimmed(ok, 'Approve') && !dimmed(ok, 'Reject'),
    `${variant(ok, 'Approve')} / ${variant(ok, 'Reject')}`)
  const notPending = footer({ ...READY, expect: null }, IDLE)
  check('no expect value: both explained as no longer pending', wrapperTitle(notPending, 'Approve') === 'This proposal is no longer pending.' && wrapperTitle(notPending, 'Reject') === 'This proposal is no longer pending.')
  const stale = footer({ ...READY, status: 'stale', reason: 'Stale target.' }, IDLE)
  check('stale preview: Approve disabled with the preview reason, Reject enabled', wrapperTitle(stale, 'Approve') === 'Stale target.' && isDisabled(stale, 'Approve') && isEnabled(stale, 'Reject'))
  check('stale preview: disabled Approve drops to the neutral variant', variant(stale, 'Approve') === 'secondary' && dimmed(stale, 'Approve')
    && variant(stale, 'Reject') === 'secondary')
  const refreshing = footer(READY, { ...IDLE, refreshing: true })
  check('refreshing: both decisions disabled with the loading reason, no Preview again', isDisabled(refreshing, 'Approve') && isDisabled(refreshing, 'Reject') && wrapperTitle(refreshing, 'Reject') === 'Loading the latest preview…' && buttonTag(refreshing, 'Preview again') === '' && refreshing.includes('Loading the latest preview…'))
  const failedPreview = renderToStaticMarkup(ReviewFooter({ rec: null, decision: IDLE, retry: true, onApprove() {}, onReject() {}, onClose() {}, onPreviewAgain() {} }))
  check('failed preview: Preview again and Close only', buttonTag(failedPreview, 'Preview again') !== '' && buttonTag(failedPreview, 'Close') !== ''
    && buttonTag(failedPreview, 'Approve') === '' && buttonTag(failedPreview, 'Reject') === '')
}

// Notices: prominent, in the footer, and never the muted tint.
{
  const conflict = decisionOutcome('skills', { status: 'conflict', reason: 'being decided by another client.' })
  const html = footer(READY, { ...IDLE, stale: true, notice: conflict.notice })
  const alert = html.match(/<div role="alert"[^>]*>/)?.[0] || ''
  check('conflict: reason shown in an alert block, danger colour', html.includes('being decided by another client.') && alert.includes('var(--ui-danger, #f87171)'), alert.slice(0, 160))
  check('conflict: notice is not the muted tertiary tint', alert !== '' && !alert.includes('var(--ui-text-tertiary)'))
  check('conflict: Preview again and Close offered, Approve and Reject disabled', buttonTag(html, 'Preview again') !== '' && buttonTag(html, 'Close') !== '' && isDisabled(html, 'Approve') && isDisabled(html, 'Reject') && wrapperTitle(html, 'Approve') === 'Preview again before deciding.')
  check('conflict: stays open (no close, no toast)', conflict.close === false && conflict.toast === undefined)
}
{
  // Decisions were disabled after the preview loaded.
  const off = decisionOutcome('memory', null, decisionsDisabledError())
  check('policy 403: says decisions are off and requires a fresh preview',
    off.notice?.text === DECISION_TEXT && off.close === false && off.stale === true, JSON.stringify(off.notice))
  const session403 = decisionOutcome('memory', null, httpError(403, 'Forbidden'))
  check('generic 403: asks the user to reconnect',
    session403.notice?.text === 'Hermes refused this session (HTTP 403). Reconnect, then Retry.', JSON.stringify(session403.notice))
}
{
  const needsReview = decisionOutcome('memory', { status: 'needs_review', reason: 'Interrupted during the write.' })
  const html = footer(READY, { ...IDLE, settled: true, notice: needsReview.notice })
  const status = html.match(/<div role="status"[^>]*>/)?.[0] || ''
  check('needs_review: reason in a warning status block, not muted', html.includes('Interrupted during the write.') && status.includes('var(--ui-warning, #d69e2e)') && !status.includes('var(--ui-text-tertiary)'), status.slice(0, 160))
  check('needs_review: labelled Needs review', html.includes('Needs review'))
  check('needs_review: Approve and Reject disabled (no longer pending), Close kept, no Preview again', isDisabled(html, 'Approve') && isDisabled(html, 'Reject') && wrapperTitle(html, 'Reject') === 'This proposal is no longer pending.' && buttonTag(html, 'Close') !== '' && buttonTag(html, 'Preview again') === '')
  check('needs_review: stays open (no close, no toast)', needsReview.close === false && needsReview.toast === undefined)
}

// Outcome -> dialog and toast. Toasts are fixed wording; no reason, id, prior or expect value goes in.
const toastOf = o => (o.toast ? { kind: o.toast.kind, message: o.toast.message } : null)
const TOASTS = [
  ['applied, memory', decisionOutcome('memory', { status: 'applied' }), { kind: 'success', message: 'Approved. The change was written to memory.' }],
  ['applied, skills', decisionOutcome('skills', { status: 'applied' }), { kind: 'success', message: 'Approved. The change was written to skills.' }],
  ['rejected', decisionOutcome('memory', { status: 'rejected' }), { kind: 'info', message: 'Rejected. Nothing was written.' }],
  ['already applied', decisionOutcome('skills', { status: 'already_resolved', prior: 'applied' }), { kind: 'info', message: 'Already approved elsewhere. Nothing changed.' }],
  ['already rejected', decisionOutcome('skills', { status: 'already_resolved', prior: 'rejected' }), { kind: 'info', message: 'Already rejected elsewhere. Nothing changed.' }],
  ['already, unknown prior', decisionOutcome('memory', { status: 'already_resolved', prior: 'constructor' }), { kind: 'info', message: 'Already resolved elsewhere. Nothing changed.' }]
]
for (const [name, outcome, toast] of TOASTS) {
  check(`outcome ${name}: closes the dialog and toasts`, outcome.close === true && JSON.stringify(toastOf(outcome)) === JSON.stringify(toast), JSON.stringify(toastOf(outcome)))
}
{
  const fallback = decisionOutcome('memory', { status: 'needs_review' })
  check('needs_review without a reason: fallback text, stays open', fallback.close === false && fallback.notice.text === 'Hermes marked this write as needing review.')
  const c = decisionOutcome('skills', { status: 'conflict', reason: 'being decided by another client.' })
  const cNoReason = decisionOutcome('skills', { status: 'conflict' })
  check('conflict: reason kept, stays open, preview again required', c.close === false && c.stale === true && c.notice.text === 'being decided by another client.' && cNoReason.notice.text.startsWith('Nothing was written'))
  const unknown = decisionOutcome('skills', { status: 'mystery' })
  check('unknown status: stays open as an error, preview again, no toast', unknown.close === false && unknown.stale === true && unknown.notice.tone === 'error' && unknown.toast === undefined)
  const refused = decisionOutcome('memory', null, httpError(409, '{"detail":"store refused"}'))
  check('decision refused (409): failure text, stays open, no toast', refused.close === false && refused.stale === true && refused.notice.text === 'Hermes could not access this profile’s pending store.' && refused.toast === undefined)
  const ipcRefused = decisionOutcome('memory', null, new Error("Error invoking remote method 'hermes:api': Error: 409: {\"detail\":\"store refused\"}"))
  check('decision refused over IPC (409): the store text, not "Could not reach Hermes."', ipcRefused.notice.text === 'Hermes could not access this profile’s pending store.', ipcRefused.notice.text)
  const down = decisionOutcome('memory', null, new TypeError('fetch failed'))
  check('decision network error: "Could not reach Hermes.", stays open', down.close === false && down.notice.text === 'Could not reach Hermes.' && down.toast === undefined)
  const leaky = { reason: 'SECRET-REASON', id: 'deadbeef', prior: 'SECRET-PRIOR', expect: { token: 'TOKEN-VALUE' } }
  const messages = [
    decisionOutcome('memory', { ...leaky, status: 'applied' }).toast.message,
    decisionOutcome('skills', { ...leaky, status: 'rejected' }).toast.message,
    decisionOutcome('skills', { ...leaky, status: 'already_resolved' }).toast.message
  ].join(' | ')
  check('toasts carry no reason, id, prior, token or expect value', !/SECRET|deadbeef|TOKEN/.test(messages), messages)
}

// Preview states inside the dialog.
{
  const gone = httpError(404, '{"detail":"no such pending write"}')
  const { paneHtml } = renderScenario(new Map([...okQueries().entries(), [singleKey, { error: gone }]]), { kind: 'memory', id: memSingle.id })
  const dlg = inDialog(paneHtml)
  check('dialog 404: no longer pending, Close only, no decision buttons', dlg.includes('That record is no longer pending') && buttonTag(dlg, 'Close') !== '' && buttonTag(dlg, 'Approve') === '' && buttonTag(dlg, 'Reject') === '')
  check('dialog 404: list still rendered', rowCount(paneHtml) === all.items.length)
}
{
  const off = httpError(404, PLUGIN_OFF_BODY)
  const { paneHtml } = renderScenario(new Map([...okQueries().entries(), [singleKey, { error: off }]]), { kind: 'memory', id: memSingle.id })
  const dlg = inDialog(paneHtml)
  check('dialog preview off (Plugin not found): turned-off text, not the gone text', dlg.includes(OFF_TEXT) && !dlg.includes('no longer pending'))
}
{
  const { paneHtml } = renderScenario(new Map([...okQueries().entries(), [singleKey, { pending: true }]]), { kind: 'memory', id: memSingle.id })
  const dlg = inDialog(paneHtml)
  check('dialog loading: Loading record…, Close only', dlg.includes('Loading record…') && buttonTag(dlg, 'Approve') === '' && buttonTag(dlg, 'Reject') === '' && buttonTag(dlg, 'Close') !== '')
}

// ---- 8. needs-review banner: the count and how to close them, with no decision controls ----
{
  // The banner is the status block whose heading says how many writes need review.
  const bannerOf = html => {
    const m = /<div role="status"[^>]*><div class="font-semibold">\d+ writes? needs? review<\/div>/.exec(html)
    if (!m) return ''
    let depth = 0
    for (const tag of html.slice(m.index).matchAll(/<\/?div\b[^>]*>/g)) {
      depth += tag[0].startsWith('</') ? -1 : 1
      if (depth === 0) return html.slice(m.index, m.index + tag.index + tag[0].length)
    }
    return ''
  }
  // Tags dropped without a space, so inline <code> reads as the sentence it sits in.
  const flat = html => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  const listWith = needs_review => new Map([[listKey, { data: { ...live.all, needs_review } }]])

  const one = renderScenario(listWith({ memory: 1, skills: 0, total: 1 }))
  const b1 = bannerOf(one.paneHtml)
  const t1 = flat(b1)
  check('needs review (1 memory): banner shown', b1 !== '', text(one.paneHtml).slice(0, 160))
  check('needs review (1 memory): singular count and per-kind line', t1.includes('1 write needs review') && t1.includes('memory 1 · skills 0'), t1)
  check('needs review (1 memory): says why, not listed, cannot be approved',
    t1.includes('approval stopped partway') && t1.includes('isn’t in the list below') && t1.includes('can’t be approved'), t1)
  check('needs review (1 memory): close it with /memory reject <id>, nothing about skills',
    b1.includes('<code') && t1.includes('/memory reject &lt;id&gt;') && !t1.includes('/skills'), t1)
  check('needs review (1 memory): /memory pending named for the id', t1.includes('/memory pending shows its id'), t1)
  const cmdBtns1 = [...b1.matchAll(/data-wr-cmd="([^"]+)"/g)].map(m => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">"))
  check('needs review (1 memory): clickable composer command chips only, no Approve button',
    JSON.stringify(cmdBtns1) === JSON.stringify(['/memory reject <id>', '/memory pending'])
    && (b1.match(/<button/g) || []).length === cmdBtns1.length && !b1.includes('>Approve<'), JSON.stringify(cmdBtns1))
  check('needs review: warning colour, not muted', b1.includes('var(--ui-warning, #d69e2e)'), b1.slice(0, 200))
  check('needs review: the list rows, counts line and badge count only pending writes', rowCount(one.paneHtml) === all.items.length
    && one.paneHtml.includes(`memory ${all.counts.memory} · skills ${all.counts.skills}`) && one.badgeHtml.includes(`pending writes: ${all.counts.total}`))

  const b2 = bannerOf(renderScenario(listWith({ memory: 2, skills: 1, total: 3 })).paneHtml)
  const t2 = flat(b2)
  const cmdBtns2 = [...b2.matchAll(/data-wr-cmd="([^"]+)"/g)].map(m => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">"))
  check('needs review (both kinds): plural count and per-kind line', t2.includes('3 writes need review') && t2.includes('memory 2 · skills 1'), t2)
  check('needs review (both kinds): both reject commands, each one', t2.includes('close each one with /memory reject &lt;id&gt; or /skills reject &lt;id&gt;.'), t2)
  check('needs review (both kinds): both pending commands and 4 clickable command chips',
    t2.includes('/memory pending or /skills pending shows their ids')
    && JSON.stringify(cmdBtns2) === JSON.stringify(['/memory reject <id>', '/skills reject <id>', '/memory pending', '/skills pending']), t2)

  const t3 = flat(bannerOf(renderScenario(listWith({ memory: 0, skills: 1, total: 1 })).paneHtml))
  check('needs review (1 skill): /skills reject <id> only', t3.includes('/skills reject &lt;id&gt;') && !t3.includes('/memory'), t3)

  const none = renderScenario(listWith({ memory: 0, skills: 0, total: 0 })).paneHtml
  check('needs review zero: no banner', bannerOf(none) === '' && rowCount(none) === all.items.length)

  const emptyQueueWithNeedsReview = renderScenario(new Map([[listKey, { data: { ...emptyData, needs_review: { memory: 1, skills: 0, total: 1 } } }]]))
  check('needs review with an empty queue: banner and the empty text', bannerOf(emptyQueueWithNeedsReview.paneHtml) !== ''
    && text(emptyQueueWithNeedsReview.paneHtml).includes('No pending writes in this profile.'))

  const failedRead = failedListQueries(httpError(502, 'Bad Gateway'), { ...live.all, needs_review: { memory: 1, skills: 0, total: 1 } })
  check('needs review: a failed read shows no banner from earlier data', bannerOf(renderScenario(failedRead).paneHtml) === '')
}

// ---- 9. copy buttons, and diff text set to be selectable ----
{
  const { paneHtml } = renderScenario(okQueries(), { kind: 'skills', id: batch.id, created_at: batch.created_at })
  const rowsHtml = [...paneHtml.matchAll(/<button[^>]*data-wr-row="[^:"]+:([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
  check('pane rows: each row shows its pending id and nests no button',
    rowsHtml.length > 0 && rowsHtml.every(([, id, inner]) => inner.includes(`>${id}</span>`) && !inner.includes('<button')))
  const preTags = [...inDialog(paneHtml).matchAll(/<pre[^>]*>/g)].map(m => m[0])
  check('dialog: every <pre> block (fields and diffs) sets user-select: text',
    preTags.length > 0 && preTags.every(tag => tag.includes('user-select:text')))

  const previewFailure = error => inDialog(renderScenario(new Map([...okQueries().entries(), [singleKey, { error }]]),
    { kind: 'memory', id: memSingle.id }).paneHtml)
  const gone = previewFailure(httpError(404, '{"detail":"no such pending write"}'))
  check('dialog 404 (gone): no Copy error button', gone.includes('no longer pending') && buttonTag(gone, 'Copy error') === '')
  const failed = previewFailure(httpError(409, '{"detail":"store refused RAW-ERROR-BODY"}'))
  check('dialog preview failure: Copy error shown, raw detail stays out of the visible text',
    buttonTag(failed, 'Copy error') !== '' && !text(failed).includes(RAW_MARK))

  const errNotice = footer(READY, { ...IDLE, stale: true, notice: { tone: 'error', text: 'Store busy.', detail: '409: RAW' } })
  const warnNotice = footer(READY, { ...IDLE, settled: true, notice: { tone: 'warning', text: 'Stopped partway.' } })
  check('notice copy chip: Copy error for errors, Copy notice for warnings',
    buttonTag(errNotice, 'Copy error') !== '' && buttonTag(warnNotice, 'Copy notice') !== '')
}

for (const [status, name, extra] of checks) console.log(`${status}  ${name}${extra ? '  -- ' + extra.slice(0, 120) : ''}`)
const failed = checks.filter(c => c[0] === 'FAIL').length
console.log(`\n${checks.length} checks, ${checks.length - failed} passed, ${failed} failed`)
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exitCode = failed ? 1 : 0
