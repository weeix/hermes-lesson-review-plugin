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
  needsReview = NO_REVIEW, sessionId = null, sessionProfile = undefined, sessionOwner = undefined, draft = '', setDraftOk = true,
  withBadge = false } = {}) {
  globalThis.__WR_PROFILE__ = 'default'
  globalThis.__WR_ACTIVATION__ = 1
  globalThis.__WR_CONNECTION__ = 'local'
  globalThis.__WR_SESSION_OWNER__ = sessionOwner
  globalThis.__WR_ON_GET_DRAFT__ = null
  globalThis.__WR_SESSION_ID__ = sessionId
  globalThis.__WR_SESSION_PROFILE__ = sessionProfile
  globalThis.__WR_DRAFT__ = draft
  globalThis.__WR_SET_DRAFT_OK__ = setDraftOk
  globalThis.__WR_COMPOSER__ = []
  globalThis.__WR_LISTENERS__ = new Map()
  globalThis.__WR_TOASTS__ = []
  globalThis.__WR_REVEALS__ = []
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
  const badge = contributions.find(c => c.id === 'badge')
  const tree = () => (withBadge ? React.createElement(React.Fragment, null, pane.render(), badge.render()) : pane.render())
  const render = () => act(async () => { root.render(React.createElement(QueryClientProvider, { client }, tree())) })
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
  await act(async () => { s.client.setQueryData(['lesson-review', 'pending', 'default', 1, 'local', 'all', 2], emptyButTotal26) })
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
    && JSON.stringify(s.state.postBodies.map(b => b?.expect)) === JSON.stringify([preview('aaaa0001').expect, preview('cccc0003').expect]),
  JSON.stringify(s.state.postBodies))
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
  check('command chips: nothing is sent and no toast', globalThis.__WR_TOASTS__.length === 0 && s.state.posts.length === 0
    && !globalThis.__WR_COMPOSER__.some(c => c.op === 'submit'))
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

// ---- 15. push events: a decision anywhere or a finished turn refreshes the list; a burst refreshes it once ----
{
  const listeners = type => globalThis.__WR_LISTENERS__.get(type)?.size || 0
  const emit = (type, payload = {}) => act(async () => {
    for (const fn of [...(globalThis.__WR_LISTENERS__.get(type) || [])]) fn({ type, payload })
  })
  // The refresh waits PUSH_SETTLE_MS (300 ms) after the last event.
  const afterSettle = async () => {
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    await settle()
  }
  const s = await mountPane()
  check('push: listening for pending.changed and message.complete',
    listeners('plugin.lesson-review.pending.changed') === 1 && listeners('message.complete') === 1)

  // A write staged by a turn, with no UI action: message.complete brings it in.
  const before = s.state.listReads
  s.state.items = [...s.state.items, ...memoryItems(['dddd0004'])]
  await emit('message.complete')
  check('push: nothing is read before the events settle', s.state.listReads === before)
  await afterSettle()
  check('push (message.complete): the list is read again and shows the new write',
    s.state.listReads === before + 1 && rows(s.host).length === 4 && Boolean(s.host.querySelector('[data-wr-row="memory:dddd0004"]')),
  `${s.state.listReads - before} reads`)

  // Five writes decided in another window: one read, not five.
  const beforeBurst = s.state.listReads
  s.state.items = s.state.items.filter(i => !['aaaa0001', 'bbbb0002'].includes(i.id))
  for (let i = 0; i < 5; i++) await emit('plugin.lesson-review.pending.changed', { kind: 'memory', status: 'rejected' })
  await afterSettle()
  check('push (pending.changed burst): one read, and the resolved writes are gone',
    s.state.listReads === beforeBurst + 1 && rows(s.host).length === 2 && !s.host.querySelector('[data-wr-row="memory:aaaa0001"]'),
  `${s.state.listReads - beforeBurst} reads`)

  await act(async () => s.root.unmount())
  check('push: unmounting removes the listeners',
    listeners('plugin.lesson-review.pending.changed') === 0 && listeners('message.complete') === 0)
}

// ---- 16. bulk reject against core's reply shapes; the run stops on a switch, a foreign preview or a closed pane ----
{
  // Core answers a preview of a write that is no longer pending with 200 and no `expect`.
  const settledPreview = (id, status, extra) => ({ ...preview(id), ...extra, status, expect: null, decisions_enabled: true })
  const previews = {
    aaaa0001: settledPreview('aaaa0001', 'already_resolved', { prior: 'applied' }),
    bbbb0002: settledPreview('bbbb0002', 'already_resolved', { prior: 'rejected' }),
    cccc0003: settledPreview('cccc0003', 'needs_review', { reason: 'stopped partway' })
  }
  const s = await mountPane({
    items: memoryItems(['aaaa0001', 'bbbb0002', 'cccc0003', 'dddd0004', 'eeee0005']),
    previewOf: id => previews[id] ?? { ...preview(id), decisions_enabled: true },
    decide: id => (id === 'dddd0004' ? Promise.reject(httpError(409, '{"detail":"store refused"}')) : rejectReply(id, 'needs_review'))
  })
  await selectAllAndReject(s, 5)
  check('settled previews: not posted; a 409 does not stop the run', JSON.stringify(s.state.posts)
    === JSON.stringify(['/pending/memory/dddd0004/reject', '/pending/memory/eeee0005/reject']), JSON.stringify(s.state.posts))
  check('settled previews: approved, rejected and needs review each counted as such', toasts().at(-1)?.message
    === 'Rejected 1 of 5. 1 was already approved elsewhere. 2 now need review; see the banner. 1 could not be rejected.',
  JSON.stringify(toasts().at(-1)))
  await act(async () => s.root.unmount())
}
{
  const s = await mountPane({ previewOf: () => Promise.reject(httpError(404, '{"detail":"Not Found"}')) })
  await selectAllAndReject(s, 3)
  check('a 404 other than "no such pending write" stops the run', s.state.previews.length === 1 && s.state.posts.length === 0
    && toasts().at(-1)?.kind === 'warning' && /before stopping/.test(toasts().at(-1)?.message ?? ''), JSON.stringify(toasts().at(-1)))
  await act(async () => s.root.unmount())
}
{
  const foreign = id => ({ ...preview(id), decisions_enabled: true, expect: { ...preview(id).expect, profile: 'another-home' } })
  const s = await mountPane({ previewOf: foreign })
  await selectAllAndReject(s, 3)
  check('a preview from another Hermes home: nothing rejected, the run stops', s.state.posts.length === 0
    && s.state.previews.length === 1 && /^The list is out of date/.test(toasts().at(-1)?.message ?? ''), JSON.stringify(toasts().at(-1)))
  await act(async () => s.root.unmount())
}
for (const [name, interrupt] of [
  ['a connection switch', async () => { globalThis.__WR_CONNECTION__ = 'ssh-box' }],
  ['the pane closing', async s => act(async () => s.root.unmount())]
]) {
  const reply = deferred()
  const s = await mountPane({ decide: () => reply.promise })
  await clickEl(button('Select'))
  await clickEl(button('All on page'))
  await clickEl(button('Reject (3)'))
  await interrupt(s)
  await act(async () => reply.resolve(rejectReply('aaaa0001', 'rejected')))
  await settle()
  check(`${name} mid-run: nothing more is read or rejected, no toast`, s.state.posts.length === 1 && s.state.previews.length === 1
    && toasts().length === 0, `${s.state.previews.length} previews, ${s.state.posts.length} posts`)
  if (s.host.isConnected && s.host.firstChild) await act(async () => s.root.unmount())
}
{
  const s = await mountPane()
  await act(async () => { button('Select').focus() })
  await clickEl(button('Select'))
  check('Select: focus moves into the bar', document.activeElement === button('All on page'), describe(document.activeElement))
  await act(async () => s.root.unmount())
}

// ---- 17. composer commands: the chat must belong to this pane's connection and profile, before and after the draft read ----
await refusal('chat on another connection: nothing written', { sessionId: 'sess-42', sessionOwner: { connectionId: 'ssh-box', profile: 'default' } },
  /another Hermes connection/)
await refusal('chat owner unknown: nothing written', { sessionId: 'sess-42', sessionOwner: null }, /can’t tell which profile/)
{
  const s = await mountPane({ needsReview: { memory: 1, skills: 0, total: 1 }, sessionId: 'sess-42' })
  globalThis.__WR_ON_GET_DRAFT__ = () => { globalThis.__WR_SESSION_ID__ = 'sess-99' }
  await clickEl(cmd(s, '/memory pending'))
  check('focus moves to another chat while the draft is read: nothing written', !globalThis.__WR_COMPOSER__.some(c => c.op === 'setDraft')
    && /changed/.test(globalThis.__WR_TOASTS__.at(-1)?.message ?? ''), composerLog())
  await act(async () => s.root.unmount())
}

// ---- 18. push events with the badge mounted too, and steady traffic ----
{
  const listeners = type => globalThis.__WR_LISTENERS__.get(type)?.size || 0
  const emit = type => act(async () => { for (const fn of [...(globalThis.__WR_LISTENERS__.get(type) || [])]) fn({ type, payload: {} }) })
  const wait = ms => act(async () => { await new Promise(r => setTimeout(r, ms)) })
  const s = await mountPane({ withBadge: true })
  check('pane and badge: each listens', listeners('message.complete') === 2)
  let before = s.state.listReads
  for (let i = 0; i < 3; i++) await emit('message.complete')
  await wait(400)
  await settle()
  check('pane and badge: a burst is still one read', s.state.listReads === before + 1, `${s.state.listReads - before} reads`)
  // An event every 250 ms for 2.5 s: the settle timer keeps moving, the 2 s cap still refreshes inside the stream.
  before = s.state.listReads
  for (let i = 0; i < 10; i++) {
    await emit('message.complete')
    await wait(250)
  }
  const during = s.state.listReads - before
  check('steady events: a refresh within 2 s, not only after they stop', during >= 1, `${during} reads during the stream`)
  await act(async () => s.root.unmount())
}

// ---- 19. polling: every 10 s while the pane shows, every 60 s while it doesn't ----
for (const [visible, ms] of [[true, 10000], [false, 60000]]) {
  globalThis.__WR_PANE_VISIBLE__ = visible
  const s = await mountPane()
  const query = s.client.getQueryCache().find({ queryKey: ['lesson-review', 'pending', 'default', 1, 'local', 'all', 1] })
  const interval = query?.observers?.[0]?.options?.refetchInterval
  check(`poll while the pane ${visible ? 'shows' : 'is hidden'}: every ${ms / 1000} s`, interval === ms, String(interval))
  await act(async () => s.root.unmount())
}
globalThis.__WR_PANE_VISIBLE__ = undefined

// ---- 20. keyboard: arrows move between rows; Mod+Enter / Mod+Backspace decide through the buttons' gate ----
{
  const s = await mountPane()
  const [first, second] = rows(s.host)
  await act(async () => { first.focus() })
  await act(async () => {
    first.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  check('ArrowDown moves focus to the next row', document.activeElement === second, describe(document.activeElement))
  await act(async () => {
    second.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
  })
  check('ArrowUp moves focus back to the previous row', document.activeElement === first, describe(document.activeElement))
  const up = new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
  await act(async () => { first.dispatchEvent(up) })
  check('ArrowUp on the first row: focus stays, the key is left to the pane', document.activeElement === first && !up.defaultPrevented)

  const press = (key, mods = {}) => act(async () => {
    dialog().dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }))
  })
  await openRow(first)
  await press('Enter')
  await settle()
  check('plain Enter in the dialog decides nothing', s.state.posts.length === 0 && Boolean(dialog()))
  await press('Enter', { ctrlKey: true, repeat: true })
  await settle()
  check('an auto-repeated Ctrl+Enter decides nothing', s.state.posts.length === 0 && Boolean(dialog()))
  await press('Enter', { ctrlKey: true })
  await settle()
  check('Ctrl+Enter approves with the preview\'s expect and closes',
    s.state.posts.at(-1) === '/pending/memory/aaaa0001/approve' && s.state.postBodies.at(-1)?.expect?.record_sha256
    && !dialog(), JSON.stringify(s.state.posts))
  await openRow(rows(s.host)[0])
  await press('Backspace', { metaKey: true })
  await settle()
  check('Cmd+Backspace rejects and closes', s.state.posts.at(-1) === '/pending/memory/bbbb0002/reject' && !dialog(),
    JSON.stringify(s.state.posts))
  await act(async () => s.root.unmount())
}

// ---- 21. Mod+Enter before the preview arrives, or while the gate is shut, approves nothing ----
{
  const gate = deferred()
  const s = await mountPane({ previewOf: id => gate.promise.then(() => memoryPreview(id)) })
  await openRow(rows(s.host)[0])
  await act(async () => {
    dialog().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
  })
  await act(async () => { gate.resolve() })
  await settle()
  check('Ctrl+Enter while the preview loads: nothing sent, now or once it lands',
    s.state.posts.length === 0 && Boolean(dialog()) && usable(button('Approve')))
  await act(async () => s.root.unmount())

  const off = await mountPane({ decisionsEnabled: false })
  await openRow(rows(off.host)[0])
  await act(async () => {
    dialog().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
  })
  await settle()
  check('Cmd+Enter with decisions off: nothing sent', off.state.posts.length === 0)
  await act(async () => off.root.unmount())
}

// ---- 22. palette and keybind actions: Show reveals the pane; the count and Refresh are the current connection's ----
{
  const s = await mountPane({ withBadge: true })
  const contributions = []
  plugin.register({ register: c => contributions.push(c) })
  const entry = (area, id) => contributions.find(c => c.area === area && c.data.id === id)?.data
  const show = entry('palette', 'lesson-review.showPane')
  const refresh = entry('palette', 'lesson-review.refresh')
  check('palette detail: the pending count', show.detail() === '3 pending' && refresh.detail() === '3 pending', show.detail())
  show.run()
  entry('keybinds', 'lesson-review.showPane').run()
  check('Show reveals this plugin\'s pane', JSON.stringify(globalThis.__WR_REVEALS__)
    === JSON.stringify(['lesson-review:pane', 'lesson-review:pane']), JSON.stringify(globalThis.__WR_REVEALS__))
  let reads = s.state.listReads
  await act(async () => { refresh.run() })
  await settle()
  check('palette Refresh reads the list again', s.state.listReads > reads, `${reads} -> ${s.state.listReads}`)
  reads = s.state.listReads
  await act(async () => { entry('keybinds', 'lesson-review.refresh').run() })
  await settle()
  check('keybind Refresh reads the list again', s.state.listReads > reads, `${reads} -> ${s.state.listReads}`)
  globalThis.__WR_PROFILE__ = 'other'
  reads = s.state.listReads
  await act(async () => { refresh.run() })
  await settle()
  check('after a profile switch: no count from the old profile, and Refresh leaves its lists alone',
    show.detail() === '' && s.state.listReads === reads, `${show.detail()} / ${reads} -> ${s.state.listReads}`)
  globalThis.__WR_PROFILE__ = 'default'
  s.state.listError = httpError(503)
  await pollList(s)
  check('after a failed read: no count', show.detail() === '', show.detail())
  s.state.listError = null
  await pollList(s)
  check('setup: the count is back', show.detail() === '3 pending', show.detail())
  await act(async () => s.root.unmount())
  check('nothing watching the list any more: no count from the cached copy', show.detail() === '', show.detail())
}

finish()
