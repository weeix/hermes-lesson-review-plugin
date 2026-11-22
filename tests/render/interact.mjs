// Interaction checks for the review dialog: real React DOM in jsdom, the host's real react-query, the SDK
// stub for everything else. Covers the transition static markup cannot: after a refused decision, Preview
// again must not let a decision use the preview being replaced, and a failed refresh leaves nothing to
// approve. Run: (cd tests/render && node interact.mjs)
import { checker, deferred, httpError, loadPluginCopy, memoryPreview, setupDom } from './harness.mjs'

await setupDom()
const { ReviewDialog } = (await loadPluginCopy('plugin-live.mjs', { sdk: 'sdk-live.mjs', extra: '\nexport const __interact = { ReviewDialog }\n' })).__interact
const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { check, finish } = checker('interaction')

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const preview = sha => memoryPreview('f17e0001', sha)
const button = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label) || null
const usable = b => Boolean(b) && !b.disabled

// One mounted dialog. `previews` is a queue of GET handlers (each returns a promise); `posts` records POSTs.
async function mount(previews, postReply) {
  globalThis.__WR_PROFILE__ = 'default'
  globalThis.__WR_TOASTS__ = []
  const posts = []
  const ctx = {
    rest(path, init) {
      if (init?.method === 'POST') {
        posts.push({ path, body: init.body })
        return Promise.resolve(postReply(posts.length))
      }
      const next = previews.shift()
      if (!next) throw new Error(`unexpected GET ${path}`)
      return next()
    }
  }
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 60_000 } } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const state = { closed: 0, posts, host, root }
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(ReviewDialog, {
        ctx, profile: 'default', activation: 1, scope: 'default',
        selected: { kind: 'memory', id: 'f17e0001', scope: 'default' },
        refreshList() {}, onClose() { state.closed++ }
      })))
  })
  await tick()
  return state
}
const click = async el => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }); await tick() }

// ---- 1. refused decision -> Preview again -> no decision until the new preview arrives ----
{
  const refresh = deferred()
  const s = await mount([() => Promise.resolve(preview('v1')), () => refresh.promise],
    n => (n === 1 ? { id: 'f17e0001', subsystem: 'memory', status: 'conflict', reason: 'being decided by another client.' }
      : { id: 'f17e0001', subsystem: 'memory', status: 'applied' }))
  check('first preview: Approve usable', usable(button(s.host, 'Approve')))
  await click(button(s.host, 'Approve'))
  check('conflict: one POST with the first preview', s.posts.length === 1 && s.posts[0].body.expect.record_sha256 === 'v1')
  check('conflict: dialog open, Preview again offered, decisions disabled',
    s.closed === 0 && Boolean(button(s.host, 'Preview again')) && !usable(button(s.host, 'Approve')) && !usable(button(s.host, 'Reject')))

  await click(button(s.host, 'Preview again'))
  check('refreshing: old preview still on screen (react-query keeps it)', s.host.textContent.includes('sample v1'))
  check('refreshing: Approve and Reject disabled', !usable(button(s.host, 'Approve')) && !usable(button(s.host, 'Reject')),
    `${button(s.host, 'Approve')?.disabled} ${button(s.host, 'Reject')?.disabled}`)
  check('refreshing: says it is loading the latest preview', s.host.textContent.includes('Loading the latest preview'))
  await click(button(s.host, 'Approve'))
  await click(button(s.host, 'Reject'))
  check('refreshing: clicks send no decision', s.posts.length === 1, `${s.posts.length} POSTs`)

  refresh.resolve(preview('v2'))
  await tick()
  check('refreshed: new preview shown, Approve usable', s.host.textContent.includes('sample v2') && usable(button(s.host, 'Approve')))
  await click(button(s.host, 'Approve'))
  check('refreshed: the decision uses only the new expect', s.posts.length === 2 && s.posts[1].body.expect.record_sha256 === 'v2',
    JSON.stringify(s.posts.map(p => p.body.expect.record_sha256)))
  check('applied: dialog closed with the success toast', s.closed === 1 &&
    globalThis.__WR_TOASTS__.some(t => t.kind === 'success' && /written to memory/.test(t.message)))
  await act(async () => s.root.unmount())
}

// ---- 2. a failed refresh leaves nothing to decide, and keeps a retry ----
{
  const refresh = deferred()
  const s = await mount([() => Promise.resolve(preview('v1')), () => refresh.promise, () => Promise.resolve(preview('v3'))],
    n => (n === 1 ? { id: 'f17e0001', subsystem: 'memory', status: 'conflict', reason: 'changed since preview' }
      : { id: 'f17e0001', subsystem: 'memory', status: 'rejected' }))
  await click(button(s.host, 'Approve'))
  await click(button(s.host, 'Preview again'))
  refresh.reject(httpError(409, '{"detail":"store refused"}'))  // a 4xx: not retried
  await tick()
  check('failed refresh: no Approve or Reject on screen', !button(s.host, 'Approve') && !button(s.host, 'Reject'))
  check('failed refresh: old preview not shown as current', !s.host.textContent.includes('sample v1'))
  check('failed refresh: Preview again still offered', usable(button(s.host, 'Preview again')))
  await click(button(s.host, 'Preview again'))
  check('retry after failure: fresh preview actionable', s.host.textContent.includes('sample v3') && usable(button(s.host, 'Reject')))
  await click(button(s.host, 'Reject'))
  check('retry after failure: decision uses the fresh expect', s.posts.length === 2 && s.posts[1].body.expect.record_sha256 === 'v3')
  await act(async () => s.root.unmount())
}

// ---- 3. a preview answered with a 4xx is final: one request, the message at once ----
{
  const s = await mount([() => Promise.reject(httpError(404, '{"detail":"no such pending write"}'))], () => ({}))
  check('preview 404: not retried, "no longer pending" at once', s.host.textContent.includes('That record is no longer pending')
    && !button(s.host, 'Approve'), s.host.textContent.slice(0, 160))
  await act(async () => s.root.unmount())
}

finish()
