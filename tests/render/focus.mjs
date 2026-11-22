// The pane and its review dialog with the host's real Radix Dialog (sdk-radix.mjs), real React DOM in jsdom
// and the host's react-query: keyboard focus on open and close, dismissal while a decision is in flight, and
// what a profile, gateway or scope switch or a failed list poll does to an open review.
// Radix returns focus to a DialogTrigger, and this plugin opens its dialog from a list row without one, so
// the plugin must return focus itself.
// Run: (cd tests/render && node focus.mjs)
import { checker, deferred, httpError, loadPluginCopy, memoryPreview, setupDom } from './harness.mjs'

const w = await setupDom()
const plugin = (await loadPluginCopy('plugin-radix.mjs', { sdk: 'sdk-radix.mjs' })).default
const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { check, finish } = checker('focus')
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 5)) })

const memoryItems = ids => ids.map((id, n) => ({
  kind: 'memory', id, action: 'add', created_at: 1_700_000_000 + n, origin: 'foreground', summary: 'Memory add',
  is_batch: false, op_count: 1
}))
const ITEMS = memoryItems(['aaaa0001', 'bbbb0002', 'cccc0003'])
// One page of the list, as core answers it: 25 per page, `total` over every page.
const NO_REVIEW = { memory: 0, skills: 0, total: 0 }
const listOf = (items, page = 1, decisionsEnabled = true, needsReview = NO_REVIEW) => ({ kind: 'all', scope: 'default', page,
  page_size: 25, total: items.length, decisions_enabled: decisionsEnabled, needs_review: needsReview,
  counts: { memory: items.length, skills: 0, total: items.length },
  gates: { memory: { write_approval: true }, skills: { write_approval: true } }, items: items.slice((page - 1) * 25, page * 25) })
const preview = id => memoryPreview(id)
const applied = id => ({ id, subsystem: 'memory', status: 'applied' })

// `decide(id, verb)` answers a POST and `previewOf(id)` a preview read (each a value or a promise);
// `state.listError`, when set, fails every list read;
// `state.scope` is the scope the list reports. The QueryClient has Desktop's own defaults
// (apps/desktop/src/lib/query-client.ts), so react-query's default retries apply unless the plugin overrides them.
// `sessionId`, `sessionProfile` and `draft` describe the focused chat for the composer stub (sdk-stub.mjs).
async function mountPane({ decide = applied, items = ITEMS, listError = null, decisionsEnabled = true, previewOf = null,
  needsReview = NO_REVIEW, sessionId = null, sessionProfile = undefined, draft = '', setDraftOk = true } = {}) {
  globalThis.__WR_PROFILE__ = 'default'
  globalThis.__WR_ACTIVATION__ = 1
  globalThis.__WR_SESSION_ID__ = sessionId
  globalThis.__WR_SESSION_PROFILE__ = sessionProfile
  globalThis.__WR_DRAFT__ = draft
  globalThis.__WR_SET_DRAFT_OK__ = setDraftOk
  globalThis.__WR_COMPOSER__ = []
  globalThis.__WR_TOASTS__ = []
  const state = { items: [...items], posts: [], postBodies: [], previews: [], listReads: 0, listError, scope: 'default', listPaths: [] }
  const ctx = {
    rest(path, init) {
      if (init?.method === 'POST') {
        state.posts.push(path)
        state.postBodies.push(init.body)
        const id = path.split('/')[3]
        const verb = path.split('/')[4]
        return Promise.resolve(decide(id, verb)).then(reply => {
          if (reply.status === 'applied' || reply.status === 'rejected') state.items = state.items.filter(i => i.id !== id)
          return reply
        })
      }
      if (path.startsWith('/pending?')) {
        state.listReads++
        state.listPaths.push(path)
        if (state.listError) return Promise.reject(state.listError)
        const page = Number(new URLSearchParams(path.split('?')[1]).get('page') || 1)
        return Promise.resolve({ ...listOf(state.items, page, decisionsEnabled, needsReview), scope: state.scope })
      }
      state.previews.push(path)
      const id = path.split('/')[3]
      return previewOf ? Promise.resolve(previewOf(id)) : Promise.resolve({ ...preview(id), decisions_enabled: decisionsEnabled })
    }
  }
  const contributions = []
  plugin.register({ ...ctx, register: c => contributions.push(c) })
  const pane = contributions.find(c => c.area === 'panes')
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 60_000 } } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = () => act(async () => { root.render(React.createElement(QueryClientProvider, { client }, pane.render())) })
  await render()
  await settle()
  return { host, root, state, client, render }
}
async function pollList(s) {
  await act(async () => { await s.client.refetchQueries({ queryKey: ['lesson-review', 'pending'] }) })
  await settle()
}
const rows = host => [...host.querySelectorAll('[data-wr-row]')]
const dialog = () => document.querySelector('[role="dialog"]')
const button = label => [...document.querySelectorAll('button')].find(b => b.textContent === label) || null
const usable = b => Boolean(b) && !b.disabled
async function clickEl(el) {
  await act(async () => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })) })
  await settle()
}
// Radix treats a pointerdown outside the content as an outside click.
async function pointerOutside() {
  await act(async () => { document.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true })) })
  await settle()
}
async function openRow(el) {
  await act(async () => { el.focus(); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })) })
  await settle()
}
async function pressEscape() {
  await act(async () => {
    const target = document.activeElement || document.body
    target.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await settle()
}
const describe = el => (el === document.body ? 'body' : el ? `${el.tagName.toLowerCase()}:${el.textContent.slice(0, 40)}` : 'null')

// ---- 1. Esc returns focus to the row that opened the dialog ----
{
  const s = await mountPane()
  const second = rows(s.host)[1]
  check('setup: three rows listed', rows(s.host).length === 3, s.host.textContent.slice(0, 300))
  await openRow(second)
  // jsdom's Radix also lands on the dialog without the plugin's open-focus handler, so this cannot show that
  // Enter would not approve on a real host; it shows focus moves into the dialog.
  check('open: focus moves to the dialog itself', Boolean(dialog()) && document.activeElement === dialog()
    && usable(button('Approve')), describe(document.activeElement))
  check('open: the footer sits outside the scrolling body', dialog().contains(button('Approve'))
    && !dialog().querySelector('[data-slot="dialog-body"]').contains(button('Approve')))
  await pressEscape()
  check('Esc: the dialog closed', !dialog())
  check('Esc: focus is back on the row that opened it', document.activeElement === second, describe(document.activeElement))
  await act(async () => s.root.unmount())
}

// ---- 2. Close button: same ----
{
  const s = await mountPane()
  const third = rows(s.host)[2]
  await openRow(third)
  await act(async () => { button('Close').dispatchEvent(new w.MouseEvent('click', { bubbles: true })) })
  await settle()
  check('Close: the dialog closed', !dialog())
  check('Close: focus is back on the row that opened it', document.activeElement === third, describe(document.activeElement))
  await act(async () => s.root.unmount())
}

// ---- 3. after a decision the row is gone: focus lands on the next row, inside the list ----
{
  const s = await mountPane()
  const [, second, third] = rows(s.host)
  await openRow(second)
  await act(async () => { button('Approve').dispatchEvent(new w.MouseEvent('click', { bubbles: true })) })
  await settle()
  await settle()
  check('decision: applied and closed', s.state.posts.length === 1 && !dialog())
  check('decision: the decided row left the list', rows(s.host).length === 2 && !rows(s.host).includes(second)
    && !s.host.querySelector('[data-wr-row="memory:bbbb0002"]'))
  check('decision: focus is on the next row, not lost to the page', document.activeElement === third && s.host.contains(document.activeElement),
    describe(document.activeElement))
  await act(async () => s.root.unmount())
}

// ---- 4. deciding the last row: focus moves up to the row before it ----
{
  const s = await mountPane()
  const [, second, third] = rows(s.host)
  await openRow(third)
  await act(async () => { button('Approve').dispatchEvent(new w.MouseEvent('click', { bubbles: true })) })
  await settle()
  await settle()
  check('last row decided: focus on the row before it', document.activeElement === second, describe(document.activeElement))
  await act(async () => s.root.unmount())
}

// ---- 5. outside click and the X close an idle dialog; while a decision is in flight nothing closes it ----
{
  const s = await mountPane()
  await openRow(rows(s.host)[0])
  await pointerOutside()
  check('idle: an outside click closes the dialog', !dialog())
  await openRow(rows(s.host)[0])
  await clickEl(document.querySelector('[aria-label="Close dialog"]'))
  check('idle: the X closes the dialog', !dialog())
  await act(async () => s.root.unmount())
}
{
  const reply = deferred()
  const s = await mountPane({ decide: () => reply.promise })
  await openRow(rows(s.host)[0])
  await clickEl(button('Approve'))
  check('busy: the decision was sent', s.state.posts.length === 1)
  await pressEscape()
  await pointerOutside()
  await clickEl(document.querySelector('[aria-label="Close dialog"]'))
  check('busy: Esc, an outside click and the X leave the dialog open', Boolean(dialog()))
  await act(async () => { reply.resolve(applied('aaaa0001')) })
  await settle()
  check('busy: the reply then closes it with a toast', !dialog() && globalThis.__WR_TOASTS__.length === 1)
  await act(async () => s.root.unmount())
}

// ---- 6. a reply that arrives after a profile switch is dropped ----
{
  const reply = deferred()
  const s = await mountPane({ decide: () => reply.promise })
  await openRow(rows(s.host)[0])
  await clickEl(button('Approve'))
  const reads = s.state.listReads
  globalThis.__WR_PROFILE__ = 'other'
  await act(async () => { reply.resolve(applied('aaaa0001')) })
  await settle()
  check('late reply: no toast, no list refresh, the dialog is not closed by it',
    globalThis.__WR_TOASTS__.length === 0 && s.state.listReads === reads && Boolean(dialog()),
    `${globalThis.__WR_TOASTS__.length} toasts, ${s.state.listReads - reads} list reads`)
  await act(async () => s.root.unmount())
}

// ---- 7. a gateway switch replaces the pane and its open review ----
{
  const s = await mountPane()
  await openRow(rows(s.host)[0])
  globalThis.__WR_ACTIVATION__ = 2
  await s.render()
  await settle()
  check('gateway switch: the review closes and the list is read again', !dialog() && rows(s.host).length === 3 && s.state.listReads >= 2)
  await act(async () => s.root.unmount())
}

// ---- 8. list polls: a failure keeps the open review, a new scope closes it ----
{
  const s = await mountPane()
  await openRow(rows(s.host)[1])
  s.state.listError = httpError(502, 'Bad Gateway')
  await pollList(s)
  check('failed list poll: the list shows the failure', s.host.textContent.includes('Could not reach Hermes.'))
  check('failed list poll: the open review stays, with its record', Boolean(dialog()) && dialog().textContent.includes('sample bbbb0002'))
  s.state.listError = null
  s.state.scope = 'restored-elsewhere'
  await pollList(s)
  check('list from another scope: the review from the old scope closes', !dialog() && rows(s.host).length === 3)
  await act(async () => s.root.unmount())
}

// ---- 9. more than one page: a range line and Previous / Next; a filter change starts over ----
{
  const ids = Array.from({ length: 26 }, (_, n) => `f${String(n).padStart(7, '0')}`)
  const s = await mountPane({ items: memoryItems(ids) })
  const text = () => s.host.textContent
  check('page 1: 25 rows and the range "1–25 of 26"', rows(s.host).length === 25 && text().includes('1–25 of 26'), text().slice(0, 160))
  check('page 1: Previous disabled, Next enabled', !usable(button('Previous')) && Boolean(button('Previous')) && usable(button('Next')))
  await clickEl(button('Next'))
  check('page 2: the last row and "26–26 of 26"', rows(s.host).length === 1 && text().includes('26–26 of 26')
    && rows(s.host)[0].getAttribute('data-wr-row') === `memory:${ids[25]}`, text().slice(0, 160))
  check('page 2: the request asked for page 2', s.state.listPaths.at(-1) === '/pending?kind=all&page=2', s.state.listPaths.at(-1))
  check('page 2: Next disabled', !usable(button('Next')))

  await openRow(rows(s.host)[0])
  await clickEl(button('Approve'))
  await settle()
  check('deciding the only row on page 2 goes back to page 1 (one page now, so no pager)', rows(s.host).length === 25
    && !text().includes(' of 25') && !button('Next'), text().slice(0, 160))

  await act(async () => s.root.unmount())
}
{
  // An empty page whose `total` still says it has rows steps back once instead of re-rendering forever.
  const ids = Array.from({ length: 26 }, (_, n) => `d${String(n).padStart(7, '0')}`)
  const s = await mountPane({ items: memoryItems(ids) })
  await clickEl(button('Next'))
  const emptyButTotal26 = { ...listOf(memoryItems(ids), 2), items: [] }
  await act(async () => { s.client.setQueryData(['lesson-review', 'pending', 'default', 1, 'all', 2], emptyButTotal26) })
  await settle()
  check('empty page 2 whose total still says 26: back to page 1, no render loop',
    rows(s.host).length === 25 && rows(s.host)[0].getAttribute('data-wr-row') === `memory:${ids[0]}`, s.host.textContent.slice(0, 160))
  await act(async () => s.root.unmount())
}
{
  const s = await mountPane({ items: memoryItems(Array.from({ length: 30 }, (_, n) => `e${String(n).padStart(7, '0')}`)) })
  await clickEl(button('Next'))
  await clickEl([...s.host.querySelectorAll('button')].find(b => b.textContent === 'Memory'))
  check('a filter change starts at page 1', s.state.listPaths.at(-1) === '/pending?kind=memory&page=1' && rows(s.host).length === 25,
    s.state.listPaths.at(-1))
  await act(async () => s.root.unmount())
}
{
  const s = await mountPane()
  check('one page: no range line and no paging buttons', !button('Next') && !button('Previous') && !s.host.textContent.includes(' of 3'))
  await act(async () => s.root.unmount())
}

// ---- 10. a 4xx answer is final: shown at once, not retried; a 5xx or network error is retried once ----
for (const [name, error, reads, text] of [
  ['plugin off (404)', httpError(404, '{"detail":"Plugin not found"}'), 1, 'turned off'],
  ['store refused (409)', httpError(409, '{"detail":"store refused"}'), 1, 'pending store'],
  ['session refused over IPC (401)', new Error("Error invoking remote method 'hermes:api': Error: 401: Unauthorized"), 1, 'refused this session'],
]) {
  const s = await mountPane({ listError: error })
  check(`${name}: one request, the message shows at once`, s.state.listReads === 1 && s.host.textContent.includes(text),
    `${s.state.listReads} reads; ${s.host.textContent.slice(0, 120)}`)
  await act(async () => s.root.unmount())
}
{
  const s = await mountPane({ listError: new TypeError('fetch failed') })
  check('network error: still loading while the one retry waits', s.state.listReads === 1 && s.host.textContent.includes('Loading pending writes'))
  await act(async () => { await new Promise(r => setTimeout(r, 1500)) })
  await settle()
  check('network error: retried once, then "Could not reach Hermes."', s.state.listReads === 2 && s.host.textContent.includes('Could not reach Hermes.'),
    `${s.state.listReads} reads`)
  await act(async () => s.root.unmount())
}

// ---- 11. multi-select mode: select rows or all on page, bulk reject with fresh expect tokens, read-only hides Select ----
{
  const s = await mountPane({ decide: (id, verb) => ({ id, subsystem: 'memory', status: verb === 'reject' ? 'rejected' : 'applied' }) })
  check('select mode: Select button shown when decisions are enabled', usable(button('Select')))
  await clickEl(button('Select'))
  check('select mode: bulk bar shown, Reject disabled with 0 selected', Boolean(s.host.querySelector('[data-wr-bulk-bar]'))
    && !usable(button('Reject')) && usable(button('All on page')) && usable(button('Done')))

  await clickEl(rows(s.host)[0])
  await clickEl(rows(s.host)[2])
  check('select mode: clicking rows toggles checkboxes instead of opening the dialog', !dialog()
    && rows(s.host)[0].getAttribute('aria-checked') === 'true'
    && rows(s.host)[1].getAttribute('aria-checked') === 'false'
    && rows(s.host)[2].getAttribute('aria-checked') === 'true'
    && usable(button('Reject (2)')))

  await clickEl(button('Reject (2)'))
  await settle()
  check('bulk reject: previewed and rejected both selected rows with their expect tokens',
    JSON.stringify(s.state.posts) === JSON.stringify(['/pending/memory/aaaa0001/reject', '/pending/memory/cccc0003/reject'])
    && s.state.postBodies.every(b => Boolean(b?.expect?.review_id)))
  check('bulk reject: exits select mode, leaves unselected row, and toasts',
    !s.host.querySelector('[data-wr-bulk-bar]') && rows(s.host).length === 1
    && rows(s.host)[0].getAttribute('data-wr-row') === 'memory:bbbb0002'
    && globalThis.__WR_TOASTS__.some(t => t.message === 'Rejected 2 writes.'))
  await act(async () => s.root.unmount())
}
{
  const s = await mountPane({ decide: id => ({ id, subsystem: 'memory', status: 'rejected' }) })
  await clickEl(button('Select'))
  await clickEl(button('All on page'))
  check('select all on page: selects all 3 rows and offers Clear', usable(button('Reject (3)')) && usable(button('Clear')))
  await clickEl(button('Clear'))
  check('clear: unchecks all rows', !usable(button('Reject')) && s.host.textContent.includes('0 selected'))
  await clickEl(button('Done'))
  check('done: exits select mode back to normal list', !s.host.querySelector('[data-wr-bulk-bar]') && usable(button('Select')))
  await act(async () => s.root.unmount())
}
{
  const s = await mountPane({ decisionsEnabled: false })
  check('read-only profile: Select button is hidden', !button('Select'))
  await act(async () => s.root.unmount())
}

// ---- 12. bulk reject outcomes: approved or resolved elsewhere, a refusal, a halt; each said in the toast ----
const toasts = () => globalThis.__WR_TOASTS__
const rejectReply = (id, status, extra = {}) => ({ id, subsystem: 'memory', status, ...extra })
async function selectAllAndReject(s, n) {
  await clickEl(button('Select'))
  await clickEl(button('All on page'))
  await clickEl(button(`Reject (${n})`))
  await settle()
}
{
  const replies = {
    aaaa0001: rejectReply('aaaa0001', 'rejected'),
    bbbb0002: rejectReply('bbbb0002', 'already_resolved', { prior: 'applied' }),
    dddd0004: rejectReply('dddd0004', 'conflict', { reason: 'changed' })
  }
  const s = await mountPane({
    items: memoryItems(['aaaa0001', 'bbbb0002', 'cccc0003', 'dddd0004']),
    decide: id => replies[id],
    previewOf: id => (id === 'cccc0003'
      ? Promise.reject(httpError(404, '{"detail":"no such pending write"}'))
      : { ...preview(id), decisions_enabled: true })
  })
  await selectAllAndReject(s, 4)
  check('mixed: every row tried, the gone one not posted', s.state.previews.length === 4
    && JSON.stringify(s.state.posts) === JSON.stringify(['aaaa0001', 'bbbb0002', 'dddd0004'].map(id => `/pending/memory/${id}/reject`)),
  JSON.stringify(s.state.posts))
  const last = toasts().at(-1)
  check('mixed: approved elsewhere is not counted as rejected; each outcome is named', last?.kind === 'warning'
    && last.message === 'Rejected 1 of 4. 1 was already approved elsewhere. 1 was no longer pending. 1 could not be rejected.',
  JSON.stringify(last))
  check('mixed: a write still pending keeps select mode, with nothing checked',
    Boolean(s.host.querySelector('[data-wr-bulk-bar]')) && s.host.textContent.includes('0 selected'))
  await act(async () => s.root.unmount())
}
{
  const s = await mountPane({ decide: id => rejectReply(id, 'already_resolved', { prior: 'rejected' }) })
  await selectAllAndReject(s, 3)
  check('already rejected elsewhere counts as rejected', toasts().at(-1)?.message === 'Rejected 3 writes.'
    && toasts().at(-1)?.kind === 'info' && !s.host.querySelector('[data-wr-bulk-bar]'), JSON.stringify(toasts().at(-1)))
  await act(async () => s.root.unmount())
}
{
  const s = await mountPane({
    decide: id => (id === 'bbbb0002'
      ? Promise.reject(httpError(501, '{"detail":"approve/reject are disabled for this profile"}'))
      : rejectReply(id, 'rejected'))
  })
  await selectAllAndReject(s, 3)
  check('halt: a 501 stops the run; the third row is never read', s.state.posts.length === 2 && s.state.previews.length === 2,
    JSON.stringify(s.state.previews))
  check('halt: the toast keeps the count rejected before stopping', toasts().at(-1)?.kind === 'warning'
    && toasts().at(-1)?.message === 'Decisions are turned off for this profile (read-only). Rejected 1 of 3 before stopping.',
  JSON.stringify(toasts().at(-1)))
  await act(async () => s.root.unmount())
}
{
  const s = await mountPane({ previewOf: () => Promise.reject(httpError(404, '{"detail":"Plugin not found"}')) })
  await selectAllAndReject(s, 3)
  check('halt: the plugin turned off (404 Plugin not found) stops at the first row', s.state.previews.length === 1
    && s.state.posts.length === 0 && /turned off/.test(toasts().at(-1)?.message ?? ''), JSON.stringify(toasts().at(-1)))
  await act(async () => s.root.unmount())
}

// ---- 13. select mode and focus: Done hands focus to Select; a running bulk reject keeps it in the pane ----
{
  const s = await mountPane()
  await clickEl(button('Select'))
  await act(async () => { button('Done').focus() })
  await clickEl(button('Done'))
  check('Done: focus moves to the Select button', document.activeElement === button('Select'), describe(document.activeElement))
  await act(async () => s.root.unmount())
}
{
  const ids = Array.from({ length: 26 }, (_, n) => `f${String(n).padStart(7, '0')}`)
  const reply = deferred()
  const s = await mountPane({ items: memoryItems(ids), decide: () => reply.promise })
  const pane = s.host.firstElementChild
  await clickEl(button('Select'))
  await clickEl(rows(s.host)[0])
  await act(async () => { button('Reject (1)').focus() })
  await clickEl(button('Reject (1)'))
  check('bulk busy: focus held on the pane, not dropped to the page', document.activeElement === pane, describe(document.activeElement))
  check('bulk busy: filters, paging and the bar are locked', !usable(button('All')) && !usable(button('Next'))
    && !usable(button('Done')) && !usable(button('Clear') || button('All on page')) && rows(s.host).every(r => r.disabled))
  await act(async () => reply.resolve(rejectReply(ids[0], 'rejected')))
  await settle()
  check('bulk done: select mode ends and focus stays in the pane', !s.host.querySelector('[data-wr-bulk-bar]')
    && pane.contains(document.activeElement), describe(document.activeElement))
  await act(async () => s.root.unmount())
}

// ---- 14. needs_review banner commands: a click puts the command in the focused chat's input, never sends it ----
const composerLog = () => JSON.stringify(globalThis.__WR_COMPOSER__)
const cmd = (s, label) => s.host.querySelector(`[data-wr-cmd="${label}"]`)
{
  const s = await mountPane({ needsReview: { memory: 1, skills: 1, total: 2 }, sessionId: 'sess-42' })
  check('command chips: one per command and kind', ['/memory reject <id>', '/skills reject <id>', '/memory pending', '/skills pending']
    .every(label => cmd(s, label)?.tagName === 'BUTTON'))
  await clickEl(cmd(s, '/memory pending'))
  check('/memory pending: written to the empty input of the focused chat, then focused', composerLog() === JSON.stringify([
    { op: 'getDraft', sessionId: 'sess-42' }, { op: 'setDraft', sessionId: 'sess-42', text: '/memory pending' },
    { op: 'focus', sessionId: 'sess-42' }]), composerLog())
  globalThis.__WR_COMPOSER__ = []
  await clickEl(cmd(s, '/skills reject <id>'))
  check('/skills reject <id>: the placeholder is dropped, the space before the id kept',
    globalThis.__WR_COMPOSER__.find(c => c.op === 'setDraft')?.text === '/skills reject ', composerLog())
  check('command chips: nothing is sent and no toast', globalThis.__WR_TOASTS__.length === 0 && s.state.posts.length === 0)
  await act(async () => s.root.unmount())
}
const refusal = async (name, opts, pattern) => {
  const s = await mountPane({ needsReview: { memory: 1, skills: 0, total: 1 }, ...opts })
  await clickEl(cmd(s, '/memory pending'))
  const toast = globalThis.__WR_TOASTS__.at(-1)
  check(name, !globalThis.__WR_COMPOSER__.some(c => c.op === 'setDraft' || c.op === 'focus')
    && toast?.kind === 'warning' && pattern.test(toast.message), `${composerLog()} ${JSON.stringify(toast)}`)
  await act(async () => s.root.unmount())
}
await refusal('no chat focused: nothing written, a toast says to open one', { sessionId: null }, /Open a chat first/)
await refusal('chat in another profile: nothing written', { sessionId: 'sess-42', sessionProfile: 'work' }, /belongs to profile work/)
await refusal('text already in the input: kept, nothing written', { sessionId: 'sess-42', draft: 'half a message' }, /already has text/)
{
  const s = await mountPane({ needsReview: { memory: 1, skills: 0, total: 1 }, sessionId: 'sess-42', setDraftOk: false })
  await clickEl(cmd(s, '/memory pending'))
  check('no input answered: a toast, no focus', !globalThis.__WR_COMPOSER__.some(c => c.op === 'focus')
    && /Could not reach the chat input/.test(globalThis.__WR_TOASTS__.at(-1)?.message ?? ''), composerLog())
  await act(async () => s.root.unmount())
}

finish()
