// Only @hermes/plugin-sdk, react and react/jsx-runtime may be imported; this file is not compiled,
// so it uses jsx()/jsxs() instead of JSX syntax.
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, KEYBINDS_AREA, PALETTE_AREA, PANES_AREA, STATUSBAR_AREAS, gatewayActivationEpoch, host, useGatewayActivationEpoch, useQuery, useQueryClient, useValue } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN = 'lesson-review'
const PANE_ID = `${PLUGIN}:pane`
const pendingKey = ({ profile, activation, connectionId }) => [PLUGIN, 'pending', profile, activation, connectionId]

const pendingPath = ({ kind, id }) => `/pending/${kind}/${id}`
const fetchPreview = (ctx, item) => ctx.rest(pendingPath(item))
const postDecision = (ctx, item, verb, expect) => ctx.rest(`${pendingPath(item)}/${verb}`, {
  method: 'POST', body: { expect }
})
// Keybind action ids (KEYBINDS_AREA); the palette rows name them so the palette shows the user's chord.
const SHOW_ACTION = `${PLUGIN}.showPane`
const REFRESH_ACTION = `${PLUGIN}.refresh`
// Push events are best effort. Polling also covers slash commands, background reviews,
// and changes outside this window's gateway or subscribed sessions.
const VISIBLE_POLL_MS = 10000
const HIDDEN_POLL_MS = 60000
const PUSH_EVENTS = [`plugin.${PLUGIN}.pending.changed`, 'message.complete']

const PUSH_SETTLE_MS = 300
const PUSH_MAX_WAIT_MS = 2000
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'memory', label: 'Memory' },
  { id: 'skills', label: 'Skills' }
]
const MUTED = { color: 'var(--ui-text-tertiary)' }
const BORDER = { border: '1px solid var(--ui-stroke-secondary)' }
const RULE = { borderTop: '1px solid var(--ui-stroke-secondary)' }
const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
const CHIP = 'inline-flex items-center rounded px-1.5 py-px text-[0.6875rem] leading-4'
// The plugin cannot rely on utility classes the host did not compile.
const DIALOG_SIZE = { width: 'min(860px, calc(100vw - 2rem))', maxWidth: 'calc(100vw - 2rem)', maxHeight: '80vh' }

function ago(ts) {
  if (!ts) return ''
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error')
}

// HTTP status of a failed call. The desktop bridge throws `Error("<status>: <body>")` with a numeric
// `statusCode` (apps/desktop/electron/api-transport.ts), but Electron's IPC passes only the message on,
// wrapped: "Error invoking remote method 'hermes:api': Error: 409: …". The pattern matches both forms,
// as the host's own checks do (apps/desktop/src/lib/gateway-rpc.ts).
function httpStatus(error) {
  const code = Number(error?.statusCode)
  if (Number.isInteger(code) && code > 0) return code
  const match = /(?:^\s*|error:\s*)(\d{3})(?::|\s|$)/i.exec(errorText(error))
  return match ? Number(match[1]) : null
}

// React Query keeps the failure message behind the loading state until retries finish.
function retryOnce(failureCount, error) {
  const status = httpStatus(error)
  return failureCount < 1 && (status === null || status >= 500)
}

const OFF_TEXT = 'Lesson review is turned off on this Hermes. Turn it on in Capabilities → Plugins.'

// What a failed read means, in words a user can act on. `detail` is the raw text, for a tooltip only;
// `gone`: a 404 other than the plugin being off (for a preview, the record is gone).
function describeFailure(error) {
  const status = httpStatus(error)
  const detail = errorText(error)
  if (status === 404 && /Plugin not found/i.test(detail)) return { text: OFF_TEXT, detail }
  if (status === 404) return { text: 'Lesson review is not available on this Hermes (HTTP 404).', detail, gone: true }
  if (status === 503 && /Write Review API/i.test(detail)) {
    return { text: 'Lesson review needs a Hermes backend with the Write Review API. See the plugin README.', detail }
  }
  if (status === 501 && /disabled/i.test(detail)) return { text: DECISION_TITLE, detail }
  if (status === 409) return { text: 'Hermes could not access this profile’s pending store.', detail }
  if (status === 401 || status === 403) {
    return { text: `Hermes refused this session (HTTP ${status}). Reconnect, then Retry.`, detail }
  }
  if (status === null || status >= 500) return { text: 'Could not reach Hermes.', detail }
  return { text: `Hermes could not answer (HTTP ${status}).`, detail }
}

function Chip({ children, title }) {
  return jsx('span', { className: CHIP, style: { ...BORDER, ...MUTED }, title, children })
}

function Gates({ gates }) {
  const parts = Object.entries(gates).map(([kind, g]) => `${kind} ${g.write_approval ? 'on' : 'off'}`)
  return jsx('div', { className: 'text-[0.6875rem]', style: MUTED, children: `write_approval: ${parts.join(' · ')}` })
}

// Pad individual lines so a diff line's background can reach the box edge.
function LabelledPre({ name, lines }) {
  return jsxs('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsx('div', { className: 'text-[0.6875rem]', style: MUTED, children: name }),
      jsx('pre', {
        className: 'whitespace-pre-wrap break-words rounded py-1.5 text-[0.75rem]',
        style: { ...MONO, ...BORDER, margin: 0, maxHeight: '11rem', overflow: 'auto' },
        children: lines
      })
    ]
  })
}

function Field({ name, value }) {
  return jsx(LabelledPre, { name, lines: jsx('div', { className: 'px-1.5', children: String(value) }) })
}

// Unified diff lines in the host's diff colours (apps/desktop styles.css `--ui-diff-*`, which follow the
// theme, dark included); the fallbacks are its light values. The +/- prefix stays, so colour is not the only cue.
const DIFF_LINE = {
  add: { background: 'var(--ui-diff-add-background, rgba(31, 138, 101, 0.12))', color: 'var(--ui-diff-add-foreground, #165f46)' },
  remove: { background: 'var(--ui-diff-remove-background, rgba(207, 45, 86, 0.12))', color: 'var(--ui-diff-remove-foreground, #91203c)' },
  meta: MUTED
}
// `---`/`+++` are file headers only before the first hunk; inside one, `----` is a removed `---` line.
function DiffField({ diff }) {
  let inHunk = false
  return jsx(LabelledPre, {
    name: 'diff',
    lines: String(diff).split('\n').map((line, i) => {
      let kind = 'context'
      if (line.startsWith('@@')) {
        inHunk = true
        kind = 'meta'
      } else if (!inHunk) {
        if (line.startsWith('---') || line.startsWith('+++')) kind = 'meta'
      } else if (line.startsWith('+')) {
        kind = 'add'
      } else if (line.startsWith('-')) {
        kind = 'remove'
      }
      return jsx('div', {
        'data-wr-diff-line': kind,
        className: 'px-1.5',
        style: DIFF_LINE[kind],
        children: line || ' '
      }, i)
    })
  })
}

function OpView({ op }) {
  const fields = Object.entries(op.fields).filter(([, v]) => v !== '' && v !== null)
  return jsxs('div', {
    className: 'flex flex-col gap-1.5 rounded p-2',
    style: BORDER,
    children: [
      jsx('div', {
        className: 'text-[0.6875rem]',
        style: MUTED,
        children: `op ${op.index} · ${op.action}${op.subject ? ` · ${op.subject}` : ''}`
      }),
      ...fields.map(([name, value]) => jsx(Field, { name, value }, name)),
      op.diff ? jsx(DiffField, { diff: op.diff }) : null
    ].filter(Boolean)
  })
}

// Approve / Reject: real `disabled` attribute, visibly dimmed, not-allowed cursor. The wrapper span owns the
// title and the cursor (see ReviewFooter): a disabled button has pointer-events: none, so its own title never shows.
const DECISION_TITLE = 'Decisions are turned off for this profile (read-only).'
function decisionButton(label, reason, onClick) {
  return jsx('span', {
    title: reason || undefined,
    style: { cursor: reason ? 'not-allowed' : undefined, display: 'inline-flex' },
    children: jsx(Button, {
      variant: !reason && label === 'Approve' ? 'default' : 'secondary',
      disabled: Boolean(reason),
      onClick,
      style: reason ? { opacity: 0.45, cursor: 'not-allowed' } : undefined,
      children: label
    })
  })
}


// Why Approve / Reject cannot be used now, as a tooltip string ('' = usable). The gate and the in-flight
// decision apply to both buttons; Approve also needs the preview itself to be `ready`.
function decisionGate(rec, decision) {
  const common = commonGate(rec, decision)
  const approve = common || (rec.status === 'ready' ? '' : rec.reason || 'This preview cannot be approved.')
  return { approve, reject: common }
}

function commonGate(rec, decision) {
  if (!rec.decisions_enabled) return DECISION_TITLE
  if (decision.busy) return 'A decision is in progress.'
  if (decision.refreshing) return 'Loading the latest preview…'
  if (decision.stale) return 'Preview again before deciding.'
  if (!rec.expect || decision.settled) return 'This proposal is no longer pending.'
  return ''
}

const ALREADY_TEXT = {
  applied: 'Already approved elsewhere. Nothing changed.',
  rejected: 'Already rejected elsewhere. Nothing changed.'
}

function textOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

// What one decision reply means for the dialog. `close` ends the dialog; `toast` is fixed wording, never
// the record, its id, the reason or the expect value. `notice` stays in the dialog. `settled`: nothing more
// can be decided on this record from here. `stale`: the preview must be read again before deciding.
function decisionOutcome(kind, result, error) {
  const closed = toast => ({ close: true, settled: true, stale: false, toast })
  if (error) {
    const failed = describeFailure(error)
    return { close: false, settled: false, stale: true, notice: { tone: 'error', text: failed.text, detail: failed.detail } }
  }
  const status = result?.status
  if (status === 'applied') {
    return closed({ kind: 'success', message: `Approved. The change was written to ${kind === 'skills' ? 'skills' : 'memory'}.` })
  }
  if (status === 'rejected') return closed({ kind: 'info', message: 'Rejected. Nothing was written.' })
  if (status === 'already_resolved') {
    const known = typeof result.prior === 'string' && Object.prototype.hasOwnProperty.call(ALREADY_TEXT, result.prior)
    return closed({ kind: 'info', message: known ? ALREADY_TEXT[result.prior] : 'Already resolved elsewhere. Nothing changed.' })
  }
  if (status === 'needs_review') {
    return {
      close: false, settled: true, stale: false,
      notice: { tone: 'warning', text: textOr(result.reason, 'Hermes marked this write as needing review.') }
    }
  }
  if (status === 'conflict') {
    return {
      close: false, settled: false, stale: true,
      notice: { tone: 'error', text: textOr(result.reason, 'Nothing was written. Preview again to see the record as it is now.') }
    }
  }
  return {
    close: false, settled: false, stale: true,
    notice: { tone: 'error', text: 'Hermes sent an answer this plugin does not recognise. Preview again to see the record.' }
  }
}

const IDLE = { busy: false, notice: null, settled: false, stale: false, refreshing: false }

const NOTICE_COLOR = {
  warning: 'var(--ui-warning, #d69e2e)',
  error: 'var(--ui-danger, #f87171)'
}
const tintedBox = tone => ({
  border: `1px solid ${NOTICE_COLOR[tone]}`,
  background: `color-mix(in srgb, ${NOTICE_COLOR[tone]} 12%, transparent)`,
  color: 'var(--ui-text-primary)'
})
function Notice({ notice }) {
  const warning = notice.tone === 'warning'
  return jsxs('div', {
    role: warning ? 'status' : 'alert',
    title: notice.detail || undefined,
    className: 'flex flex-col gap-0.5 rounded p-2 text-[0.8125rem]',
    style: tintedBox(notice.tone),
    children: [
      jsx('div', { className: 'font-semibold', children: warning ? 'Needs review' : 'Not decided' }),
      jsx('div', { children: notice.text })
    ]
  })
}


function ReviewFooter({ rec, decision, retry, onApprove, onReject, onClose, onPreviewAgain }) {
  const gate = rec ? decisionGate(rec, decision) : null
  return jsxs('div', {
    className: 'flex flex-col gap-2 px-4 py-3',
    style: RULE,
    children: [
      decision.notice ? jsx(Notice, { notice: decision.notice }) : null,
      rec && !rec.decisions_enabled ? jsx('div', { className: 'text-[0.6875rem]', style: MUTED, children: DECISION_TITLE }) : null,
      decision.refreshing ? jsx('div', { role: 'status', className: 'text-[0.6875rem]', style: MUTED, children: 'Loading the latest preview…' }) : null,
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          gate ? decisionButton('Approve', gate.approve, onApprove) : null,
          gate ? decisionButton('Reject', gate.reject, onReject) : null,
          (decision.stale || retry) && !decision.busy && !decision.refreshing
            ? jsx(Button, { variant: 'secondary', onClick: onPreviewAgain, children: 'Preview again' })
            : null,
          jsx('span', {
            className: 'ml-auto',
            children: jsx(Button, { variant: 'ghost', disabled: decision.busy, onClick: onClose, children: 'Close' })
          })
        ].filter(Boolean)
      })
    ].filter(Boolean)
  })
}

function ReviewBody({ rec, fallbackCreatedAt }) {
  const age = ago(rec.created_at ?? fallbackCreatedAt)
  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-1.5',
        children: [
          jsx(Chip, { children: rec.kind }),
          jsx(Chip, { children: rec.origin }),
          jsx(Chip, { children: rec.is_batch ? `batch · ${rec.op_count} ops` : rec.action }),
          jsx('span', { className: 'text-[0.6875rem]', style: MUTED, children: age ? `${rec.id} · ${age}` : rec.id })
        ]
      }),
      rec.summary ? jsx('div', { className: 'text-[0.75rem]', children: rec.summary }) : null,
      rec.reason ? jsx('div', { className: 'text-[0.75rem]', children: rec.reason }) : null,
      rec.notice ? jsx('div', { className: 'text-[0.75rem]', children: rec.notice }) : null,
      ...rec.ops.map(op => jsx(OpView, { op }, op.index))
    ].filter(Boolean)
  })
}

// Radix would focus the first enabled button (Approve, when it is enabled), so a stray Enter could approve.
// Focus the dialog itself; Tab reaches the buttons.
function focusDialog(event) {
  event.preventDefault()
  event.currentTarget?.focus?.()
}

const isEditable = el => Boolean(el?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || '')

function ReviewDialog({ ctx, profile, activation, connectionId, selected, refreshList, onClose, restoreFocus }) {
  const [decision, setDecision] = useState(IDLE)
  const inFlight = useRef(false)
  // True once a decision closed the dialog, so focus goes to the next row instead of the removed one.
  const decided = useRef(false)
  // Set from the Preview again click until the refetch settles: no decision may use the preview being replaced.
  const refreshing = useRef(false)
  const preview = useQuery({
    queryKey: [PLUGIN, 'preview', profile, activation, connectionId, selected.scope, selected.kind, selected.id],
    queryFn: () => fetchPreview(ctx, selected),
    retry: retryOnce
  })
  // While any refetch runs, react-query still returns the previous preview (isPending false); decisions wait
  // for the new one. A failed refetch is isError, so the old preview is never actionable after it.
  const rec = preview.isPending || preview.isError ? null : preview.data
  const view = { ...decision, refreshing: decision.refreshing || preview.isFetching === true }
  const retry = preview.isError
  const sameConnection = () => isConnection({ profile, activation, connectionId })
  // Radix sends Esc, the X and an outside click here too (onOpenChange), so all are ignored while busy.
  const close = () => { if (!inFlight.current) onClose() }

  async function decide(verb) {
    if (!rec || inFlight.current || refreshing.current || !sameConnection()) return
    if (decisionGate(rec, view)[verb]) return
    inFlight.current = true
    setDecision({ ...IDLE, busy: true })
    let outcome
    try {
      const result = await postDecision(ctx, selected, verb, rec.expect)
      outcome = decisionOutcome(selected.kind, result, null)
    } catch (error) {
      outcome = decisionOutcome(selected.kind, null, error)
    }
    inFlight.current = false
    if (!sameConnection()) return
    refreshList()
    if (outcome.toast) host.notify(outcome.toast)
    if (outcome.close) {
      decided.current = true
      onClose()
      return
    }
    setDecision({ busy: false, notice: outcome.notice, settled: outcome.settled, stale: outcome.stale })
  }

  async function previewAgain() {
    if (inFlight.current || refreshing.current) return
    refreshing.current = true
    setDecision({ ...IDLE, refreshing: true })
    try {
      await preview.refetch()
    } finally {
      refreshing.current = false
      if (sameConnection()) setDecision(current => ({ ...current, refreshing: false }))
    }
  }

  let body
  if (preview.isPending) {
    body = jsx('div', { className: 'text-[0.75rem]', style: MUTED, children: 'Loading record…' })
  } else if (preview.isError) {
    const failed = describeFailure(preview.error)
    body = jsx('div', {
      className: 'text-[0.75rem]',
      title: failed.detail,
      children: failed.gone ? 'That record is no longer pending. Pick another item.' : failed.text
    })
  } else {
    body = jsx(ReviewBody, { rec: preview.data, fallbackCreatedAt: selected.created_at })
  }

  // A chord still held from opening the row must not approve once the preview lands.
  // No ⌘/Ctrl+R for Preview again: Desktop's main process claims that chord before the page sees it.
  function onDialogKeyDown(event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    if (event.defaultPrevented || event.nativeEvent?.isComposing || isEditable(event.target)) return
    const verb = event.key === 'Enter' ? 'approve' : event.key === 'Backspace' ? 'reject' : null
    if (!verb) return
    event.preventDefault()
    if (!event.repeat) decide(verb)
  }

  return jsx(Dialog, {
    open: true,
    onOpenChange: open => { if (!open) close() },
    children: jsxs(DialogContent, {
      style: DIALOG_SIZE,
      onOpenAutoFocus: focusDialog,
      onKeyDown: onDialogKeyDown,
      // Radix returns focus to a DialogTrigger; this dialog opens from a list row without one, so on close
      // Radix would drop focus to the page. Hand it back to the list instead. Radix runs this after unmount.
      onCloseAutoFocus: event => {
        event.preventDefault()
        restoreFocus(decided.current)
      },
      chrome: jsx(ReviewFooter, {
        rec,
        decision: view,
        retry,
        onApprove: () => decide('approve'),
        onReject: () => decide('reject'),
        onClose: close,
        onPreviewAgain: previewAgain
      }),
      children: [
        jsxs(DialogHeader, {
          style: { paddingRight: '2rem' },
          children: [
            jsx(DialogTitle, { children: 'Review pending write' }),
            jsx(DialogDescription, {
              children: 'Approve (⌘/Ctrl+Enter) applies this staged write. Reject (⌘/Ctrl+Backspace) discards it.'
            })
          ]
        }),
        body
      ]
    })
  })
}

const CODE = { ...MONO, fontSize: '0.75rem' }

// The composer address of the focused chat: its runtime id, else its stored id (a chat that is shown but not
// resumed), else `'new'`, the SDK's address for a new chat's input before its first message gives it an id.
function focusedChatAddress() {
  return host.state?.focusedSessionId?.get?.() || host.state?.focusedStoredSessionId?.get?.() || 'new'
}

// Why the focused chat is not one this pane's commands may go to, or '' when it is. The command acts on
// whichever profile and Hermes the chat belongs to, so the chat must have this pane's owner: the same
// connection and profile (`focusedSessionOwner`; null when the owner is unknown or ambiguous, which is
// refused; for a new chat, the active gateway's, where its first message will start it). A Desktop without
// `focusedSessionOwner` can only compare profile names.
function chatMismatch({ profile, connectionId }) {
  const sessionId = focusedChatAddress()
  const paneProfile = (profile || '').trim() || 'default'
  const ownerAtom = host.state?.focusedSessionOwner
  if (typeof ownerAtom?.get === 'function') {
    const owner = ownerAtom.get()
    if (!owner) return { sessionId, reason: 'unknown' }
    if ((owner.profile || 'default') !== paneProfile) return { sessionId, reason: 'profile', other: owner.profile }
    if ((owner.connectionId || null) !== (connectionId || null)) return { sessionId, reason: 'connection' }
    return { sessionId, reason: '' }
  }
  const chatProfile = host.state?.focusedSessionProfile?.get?.()
  if (typeof chatProfile !== 'string') return { sessionId, reason: 'unknown' }
  if ((chatProfile.trim() || 'default') !== paneProfile) return { sessionId, reason: 'profile', other: chatProfile }
  return { sessionId, reason: '' }
}

// Focus or gateway ownership can change while the draft read is in flight.
async function stageCommandInComposer(command, conn) {
  const say = message => host.notify({ kind: 'warning', message })
  const composer = host.composer
  const paneProfile = (conn.profile || '').trim() || 'default'
  const refusal = ({ reason, other }) => ({
    none: `This Desktop can’t write to the chat input. Type ${command} in the chat yourself.`,
    unknown: `Hermes can’t tell which profile the open chat belongs to. Open a chat in ${paneProfile}, then click ${command} again.`,
    profile: `The open chat belongs to profile ${other || 'default'}, not ${paneProfile}. Open a chat in ${paneProfile} first.`,
    connection: `The open chat is on another Hermes connection than this pane. Open a chat on this one first.`
  })[reason]
  if (typeof composer?.setDraft !== 'function' || typeof composer?.getDraft !== 'function') {
    say(refusal({ reason: 'none' }))
    return
  }
  const first = chatMismatch(conn)
  if (first.reason) {
    say(refusal(first))
    return
  }
  // setDraft keeps the text as given, so `/kind reject ` ends in the space the id goes after.
  const text = command.endsWith('<id>') ? command.slice(0, -'<id>'.length) : command
  const unreachable = 'Could not reach the chat input. Click into the chat, then try again.'
  try {
    const draft = await composer.getDraft(first.sessionId)
    const again = chatMismatch(conn)
    if (again.reason || again.sessionId !== first.sessionId || !isConnection(conn)) {
      say(again.reason ? refusal(again) : 'The chat or connection changed. Click the command again.')
      return
    }
    if (draft && draft.trim() && draft.trim() !== text.trim()) {
      say(`The chat input already has text. Clear it, then click ${command} again.`)
      return
    }
    if (!(await composer.setDraft(first.sessionId, text))) {
      say(unreachable)
      return
    }
  } catch {
    say(unreachable)
    return
  }
  composer.focus?.(first.sessionId)
}

function commandChip(kind, verb, conn) {
  const label = `/${kind} ${verb}`
  return jsx('button', {
    type: 'button',
    'data-wr-cmd': label,
    title: `Insert ${label} into the chat input`,
    onClick: () => { stageCommandInComposer(label, conn) },
    className: 'inline-flex items-center rounded px-1 py-px hover:opacity-80',
    style: { ...BORDER, background: 'color-mix(in srgb, var(--ui-text-primary) 6%, transparent)', cursor: 'pointer' },
    children: jsx('code', { style: CODE, children: label })
  }, `${verb}-${kind}`)
}

function commands(verb, kinds, conn) {
  return kinds.flatMap((kind, i) => [
    i ? ' or ' : null,
    commandChip(kind, verb, conn)
  ]).filter(Boolean)
}

// Core's needs_review counts cover both kinds even when the list is filtered.
function NeedsReviewBanner({ counts, conn }) {
  const one = counts.total === 1
  const kinds = ['memory', 'skills'].filter(kind => counts[kind] > 0)
  return jsxs('div', {
    role: 'status',
    'data-wr-needs-review': '',
    className: 'flex flex-col gap-1 rounded p-2 text-[0.75rem]',
    style: tintedBox('warning'),
    children: [
      jsx('div', {
        className: 'font-semibold',
        children: one ? '1 write needs review' : `${counts.total} writes need review`
      }),
      jsx('div', { className: 'text-[0.6875rem]', style: MUTED, children: `memory ${counts.memory} · skills ${counts.skills}` }),
      jsx('div', {
        children: one
          ? 'Its approval stopped partway, so the files may be partly changed. It isn’t in the list below and can’t be approved.'
          : 'Their approval stopped partway, so the files may be partly changed. They aren’t in the list below and can’t be approved.'
      }),
      jsxs('div', {
        children: [
          `Check the files by hand, then close ${one ? 'it' : 'each one'} with `,
          ...commands('reject <id>', kinds, conn),
          '. ',
          ...commands('pending', kinds, conn),
          one ? ' shows its id.' : ' shows their ids.',
          ' Click a command to put it in the chat input.'
        ]
      })
    ]
  })
}

// What every query is keyed by: the profile, the gateway activation and the connection (registry source).
// A change of any is a new connection. The epoch alone is not enough: Desktop bumps it when a switch
// starts, before the route moves, so two gateways serving the same profile name can share an epoch.
function useConnection() {
  const connectionAtom = host.state.connectionId
  return {
    profile: useValue(host.state.profile),
    activation: useGatewayActivationEpoch(),
    connectionId: connectionAtom ? (useValue(connectionAtom) ?? null) : null
  }
}

const currentConnectionId = () => host.state.connectionId?.get?.() ?? null

function isConnection({ profile, activation, connectionId }) {
  return host.state.profile.get() === profile && gatewayActivationEpoch() === activation
    && currentConnectionId() === connectionId
}

function usePaneVisible() {
  const atom = typeof host.paneVisibility === 'function' ? host.paneVisibility(PANE_ID) : null
  return atom ? Boolean(useValue(atom)) : true
}

// One timer per connection, shared by every listener, so a burst of events refreshes the lists once. A timer
// left when the last listener unmounts is harmless: it refreshes only a connection still current.
const pushTimers = new Map()

// Refreshes this connection's cached pending lists on the `PUSH_EVENTS`. Subscribes with `host.onEvent`, not
// `ctx.onEvent`: the effect's cleanup disposes it, and `ctx.onEvent` would also keep every disposer until the
// plugin unloads, one per pane or badge mount.
function usePendingPushSync({ profile, activation, connectionId }) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (typeof host.onEvent !== 'function') return undefined
    const conn = { profile, activation, connectionId }
    const queryKey = pendingKey(conn)
    const key = JSON.stringify(queryKey)
    const refresh = () => {
      pushTimers.delete(key)
      if (isConnection(conn)) {
        queryClient.invalidateQueries({ queryKey })
      }
    }
    // A continuous stream of events must not postpone the refresh indefinitely.
    const onPush = () => {
      const now = Date.now()
      const pending = pushTimers.get(key)
      if (pending && now - pending.first >= PUSH_MAX_WAIT_MS - PUSH_SETTLE_MS) return
      clearTimeout(pending?.timer)
      pushTimers.set(key, { first: pending?.first ?? now, timer: setTimeout(refresh, PUSH_SETTLE_MS) })
    }
    const offs = PUSH_EVENTS.map(event => host.onEvent(event, onPush)).filter(off => typeof off === 'function')
    return () => { for (const off of offs) off() }
  }, [queryClient, profile, activation, connectionId])
}

// The palette rows and keybind actions run outside React. They reach the app's QueryClient through the one
// the pending lists last mounted with (Desktop has one per window), and act only on the current connection.
let appQueryClient = null

const currentPendingKey = () => pendingKey({
  profile: host.state.profile.get(), activation: gatewayActivationEpoch(), connectionId: currentConnectionId()
})

function showPane() {
  host.revealPane(PANE_ID)
}

function refreshPendingNow() {
  appQueryClient?.invalidateQueries({ queryKey: currentPendingKey() })
}

// `N pending` from the current connection's first `all` page while the badge or pane still watches it; '' when
// nothing does (the cached copy is no longer refreshed), before the first read, or after a failed one.
function pendingDetail() {
  const query = appQueryClient?.getQueryCache().find({ queryKey: [...currentPendingKey(), 'all', 1], exact: true })
  if (!query?.getObserversCount() || query.state.status !== 'success') return ''
  return `${query.state.data.counts.total} pending`
}

// The pending list for one filter. A failed read shows nothing from an earlier read: react-query keeps
// the last good data on error, and showing those counts as current would be wrong.
function usePendingList(ctx, conn, filter, page = 1) {
  const paneVisible = usePaneVisible()
  const queryClient = useQueryClient()
  useEffect(() => { appQueryClient = queryClient }, [queryClient])
  usePendingPushSync(conn)
  const list = useQuery({
    queryKey: [...pendingKey(conn), filter, page],
    queryFn: () => ctx.rest(`/pending?kind=${filter}&page=${page}`),
    refetchInterval: paneVisible ? VISIBLE_POLL_MS : HIDDEN_POLL_MS,
    retry: retryOnce
  })
  const failed = list.isError ? describeFailure(list.error) : null
  return { list, failed, data: failed || list.isPending ? undefined : list.data }
}

function PendingPane({ ctx }) {
  const { profile, activation, connectionId } = useConnection()
  return jsx(ScopedPane, { ctx, profile, activation, connectionId }, JSON.stringify([profile, activation, connectionId]))
}

const itemKey = item => `${item.kind}:${item.id}`

// Failures that no later item can avoid: session refused, decisions off, Hermes unreachable. A 409 (store
// refused) is not here: it can be one kind's store or one record's lock while the next row would go through.
const BULK_HALT = new Set([null, 401, 403, 501, 502, 503, 504])
const MOVED = 'The list is out of date: Hermes now answers for another profile. Nothing more was rejected.'

// Bulk rejection is the one multi-item action that needs no diff reading: every selected row is previewed
// fresh for its `expect` token, then rejected one by one. Approve stays inside ReviewDialog so no proposal
// is ever written without showing its full content and diff first. The fresh `expect` pins the record as it
// is at reject time, not as listed; a row shows no content, so there is no earlier version the user read.
// `scope` is the profile identity the list came from: a preview whose `expect.profile` differs was answered
// by another Hermes home (a switch under way), so the run stops before rejecting anything there.
//
// Tally: `rejected` (by this run, or already rejected elsewhere), `approved` (approved elsewhere first),
// `gone` (no longer pending), `review` (now needs review: the banner, not this list), `failed` (still
// pending). `halted`: why the run stopped early; null when it went through the list. null overall: the
// connection changed or the pane closed.
async function runBulkReject(ctx, targets, scope, stillHere) {
  const tally = { rejected: 0, approved: 0, gone: 0, review: 0, failed: 0, halted: null }
  // A decision reply, or a preview of a write that is no longer pending (200, no `expect`).
  const settled = reply => {
    const status = reply?.status
    const prior = status === 'already_resolved' ? reply.prior : null
    if (status === 'rejected' || prior === 'rejected') tally.rejected++
    else if (prior === 'applied') tally.approved++
    else if (status === 'already_resolved') tally.gone++
    else if (status === 'needs_review') tally.review++
    else return false
    return true
  }
  for (const item of targets) {
    if (!stillHere()) return null
    try {
      const preview = await fetchPreview(ctx, item)
      if (!stillHere()) return null
      if (!preview?.decisions_enabled) return { ...tally, halted: DECISION_TITLE }
      if (!preview.expect) {
        if (!settled(preview)) tally.failed++
        continue
      }
      if (preview.expect.profile !== scope) return { ...tally, halted: MOVED }
      const res = await postDecision(ctx, item, 'reject', preview.expect)
      if (!stillHere()) return null
      if (!settled(res)) tally.failed++
    } catch (error) {
      const status = httpStatus(error)
      // Only the route's own 404 means the record is gone; any other (the plugin off, an older backend
      // without the route) would fail the same way for every row.
      if (status === 404 && /no such pending write/i.test(errorText(error))) tally.gone++
      else if (status === 404 || BULK_HALT.has(status)) return { ...tally, halted: describeFailure(error).text }
      else tally.failed++
    }
  }
  return tally
}

const writes = n => (n === 1 ? '1 write' : `${n} writes`)
const wasWere = n => (n === 1 ? 'was' : 'were')

function bulkSummary(total, tally) {
  const { rejected, approved, gone, review, failed, halted } = tally
  const done = !halted && failed === 0
  if (done && rejected === total) return { done, toast: { kind: 'info', message: `Rejected ${writes(rejected)}.` } }
  const parts = [halted ? `${halted} Rejected ${rejected} of ${total} before stopping.` : `Rejected ${rejected} of ${total}.`]
  if (approved) parts.push(`${approved} ${wasWere(approved)} already approved elsewhere.`)
  if (gone) parts.push(`${gone} ${wasWere(gone)} no longer pending.`)
  if (review) parts.push(`${review} now ${review === 1 ? 'needs' : 'need'} review; see the banner.`)
  if (failed) parts.push(`${failed} could not be rejected.`)
  const warn = Boolean(halted) || failed > 0 || approved > 0 || review > 0
  return { done, toast: { kind: warn ? 'warning' : 'info', message: parts.join(' ') } }
}

function BulkBar({ pageCount, checkedCount, allChecked, busy, decisionsOff, onSelectAll, onReject, onDone }) {
  const rejectReason = decisionsOff
    ? DECISION_TITLE
    : busy
      ? 'Rejecting selected items…'
      : checkedCount === 0
        ? 'Select at least one item to reject.'
        : ''
  return jsxs('div', {
    'data-wr-bulk-bar': '',
    className: 'flex flex-wrap items-center gap-1.5 rounded p-1.5 text-[0.6875rem]',
    style: BORDER,
    children: [
      pageCount > 0
        ? jsx('button', {
          type: 'button',
          disabled: busy,
          onClick: onSelectAll,
          className: 'rounded px-1.5 py-0.5',
          style: { ...BORDER, ...(busy ? { opacity: 0.45, cursor: 'not-allowed' } : undefined) },
          children: allChecked ? 'Clear' : 'All on page'
        })
        : null,
      jsx('span', { style: MUTED, children: busy ? 'Rejecting…' : `${checkedCount} selected` }),
      jsxs('div', {
        className: 'ml-auto flex items-center gap-1.5',
        children: [
          decisionButton(checkedCount > 0 ? `Reject (${checkedCount})` : 'Reject', rejectReason, onReject),
          jsx(Button, { variant: 'ghost', disabled: busy, onClick: onDone, children: 'Done' })
        ]
      })
    ].filter(Boolean)
  })
}

function ScopedPane({ ctx, profile, activation, connectionId }) {
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(null)
  const [selecting, setSelecting] = useState(false)
  const [checked, setChecked] = useState([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const bulkInFlight = useRef(false)
  const refocusAfterSelect = useRef(false)
  // Where keyboard focus goes when the dialog closes: the row that opened it, or after a decision removed
  // that row, the row now in its place. `paneRef` is the fallback and tells whether this scope still shows.
  const paneRef = useRef(null)
  const opener = useRef(null)
  const conn = { profile, activation, connectionId }
  const { list, failed, data } = usePendingList(ctx, conn, filter, page)
  const queryClient = useQueryClient()
  // After a decision every cached list page of this connection is out of date, not only the one shown
  // (the badge's, other filters', other pages').
  const refreshLists = () => queryClient.invalidateQueries({ queryKey: pendingKey(conn) })
  const items = data?.items ?? []
  // A decision can empty the last page: show the page that is now last instead. Always step back at least one
  // page, so a reply whose `total` disagrees with its empty `items` cannot set the same page on every render.
  if (data && page > 1 && items.length === 0) setPage(Math.min(page - 1, Math.max(1, Math.ceil(data.total / data.page_size))))
  const needsReview = data?.needs_review?.total > 0 ? data.needs_review : null
  const decisionsOff = data?.decisions_enabled === false
  const pageKeys = items.map(itemKey)
  const visibleChecked = checked.filter(k => pageKeys.includes(k))
  const allChecked = pageKeys.length > 0 && visibleChecked.length === pageKeys.length
  const sameConnection = () => isConnection(conn)
  // False once the pane unmounts (closed, or replaced on a switch): a bulk run stops at the next row.
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  // Entering or leaving select mode unmounts the button that had focus: move it to the bar's first button
  // on the way in, and to Select (or the pane) on the way out.
  useEffect(() => {
    if (!refocusAfterSelect.current) return
    refocusAfterSelect.current = false
    const pane = paneRef.current
    if (!pane?.isConnected) return
    const target = selecting ? pane.querySelector('[data-wr-bulk-bar] button:not([disabled])') : pane.querySelector('[data-wr-select]')
    ;(target || pane).focus()
  }, [selecting])

  function exitSelecting() {
    if (bulkInFlight.current) return
    refocusAfterSelect.current = true
    setSelecting(false)
    setChecked([])
  }

  function toggleRow(key) {
    if (bulkInFlight.current) return
    setChecked(prev => {
      const cur = prev.filter(k => pageKeys.includes(k))
      return cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]
    })
  }

  async function rejectSelected() {
    if (bulkInFlight.current || visibleChecked.length === 0 || decisionsOff || !sameConnection()) return
    const targets = items.filter(item => visibleChecked.includes(itemKey(item)))
    bulkInFlight.current = true
    setBulkBusy(true)
    // The Reject button and the rows are disabled while the run goes, and the bar may unmount after it:
    // hold focus on the pane so it does not drop to the page.
    paneRef.current?.focus()
    let tally = null
    try {
      tally = await runBulkReject(ctx, targets, data.scope, () => mounted.current && sameConnection())
    } finally {
      bulkInFlight.current = false
      if (sameConnection()) setBulkBusy(false)
    }
    if (!tally || !mounted.current || !sameConnection()) return
    refreshLists()
    setChecked([])
    const { done, toast } = bulkSummary(targets.length, tally)
    if (done) setSelecting(false)
    host.notify(toast)
  }

  function restoreFocus(decided) {
    const pane = paneRef.current
    const from = opener.current
    opener.current = null
    // A profile or gateway switch replaced this pane: leave focus to the host.
    if (!pane || !pane.isConnected) return
    const rows = [...pane.querySelectorAll('[data-wr-row]')]
    let target = null
    if (from) {
      const own = rows.find(row => row.getAttribute('data-wr-row') === from.key)
      if (!decided && own) target = own
      else {
        const others = rows.filter(row => row.getAttribute('data-wr-row') !== from.key)
        target = others[Math.min(from.index, others.length - 1)] || null
      }
    }
    ;(target || pane).focus()
  }

  let body
  if (failed) {
    body = jsxs('div', {
      className: 'flex flex-col items-start gap-2 text-[0.75rem]',
      children: [
        jsx('div', { title: failed.detail, children: failed.text }),
        jsx(Button, { onClick: () => list.refetch(), children: 'Retry' })
      ]
    })
  } else if (list.isPending) {
    body = jsx('div', { className: 'text-[0.75rem]', style: MUTED, children: 'Loading pending writes…' })
  } else if (items.length === 0) {
    body = jsx('div', { className: 'text-[0.75rem]', style: MUTED, children: 'No pending writes in this profile.' })
  } else {
    body = jsx('div', {
      className: 'flex flex-col gap-1',
      onKeyDown: event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        const listRows = [...event.currentTarget.querySelectorAll('[data-wr-row]')].filter(r => !r.disabled)
        const idx = listRows.indexOf(event.target)
        const next = idx < 0 ? null : listRows[idx + (event.key === 'ArrowDown' ? 1 : -1)]
        if (!next) return
        event.preventDefault()
        next.focus()
      },
      children: items.map((item, index) => {
        const key = itemKey(item)
        const isChecked = selecting && visibleChecked.includes(key)
        const active = isChecked || (!selecting && selected && selected.scope === data.scope && selected.kind === item.kind && selected.id === item.id)
        return jsxs('button', {
          type: 'button',
          'data-wr-row': key,
          role: selecting ? 'checkbox' : undefined,
          'aria-checked': selecting ? isChecked : undefined,
          disabled: selecting && bulkBusy,
          onClick: () => {
            if (selecting) {
              toggleRow(key)
              return
            }
            opener.current = { key, index }
            setSelected({ kind: item.kind, id: item.id, scope: data.scope, created_at: item.created_at })
          },
          className: 'flex flex-col items-start gap-0.5 rounded p-2 text-left text-[0.75rem]',
          style: {
            ...BORDER,
            background: active ? 'var(--ui-stroke-secondary)' : 'transparent',
            ...(selecting && bulkBusy ? { opacity: 0.6, cursor: 'not-allowed' } : undefined)
          },
          children: [
            jsxs('div', {
              className: 'flex w-full items-center gap-1.5',
              children: [
                selecting
                  ? jsx('span', {
                    'aria-hidden': 'true',
                    className: 'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[0.625rem] leading-none',
                    style: {
                      ...BORDER,
                      background: isChecked ? 'var(--ui-accent)' : 'transparent',
                      color: isChecked ? 'var(--ui-bg-primary, #fff)' : 'transparent'
                    },
                    children: '✓'
                  })
                  : null,
                jsx(Chip, { children: item.kind }),
                jsx('span', { className: 'min-w-0 truncate font-medium', children: item.action }),
                jsx('span', { className: 'ml-auto shrink-0 text-[0.6875rem]', style: MUTED, children: ago(item.created_at) })
              ].filter(Boolean)
            }),
            jsx('div', { className: 'w-full truncate text-[0.6875rem]', style: MUTED, children: item.summary }),
            jsx('div', {
              className: 'text-[0.6875rem]',
              style: MUTED,
              children: `${item.origin}${item.is_batch ? ` · batch of ${item.op_count}` : ''}`
            })
          ]
        }, key)
      })
    })
  }

  return jsxs('div', {
    ref: paneRef,
    // Focusable only from code: the fallback when the dialog closes and no row is left to focus.
    tabIndex: -1,
    style: { outline: 'none' },
    className: 'flex h-full min-h-0 flex-col gap-2 overflow-auto p-3 text-sm',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2',
        children: [
          jsx('div', { className: 'font-medium', children: 'Lesson review' }),
          jsx(Chip, { title: 'Profile this pane reads', children: profile || 'default' })
        ]
      }),
      data
        ? jsx('div', {
          className: 'text-[0.6875rem]',
          style: MUTED,
          children: `memory ${data.counts.memory} · skills ${data.counts.skills}`
        })
        : null,
      data ? jsx(Gates, { gates: data.gates }) : null,
      needsReview ? jsx(NeedsReviewBanner, { counts: needsReview, conn }) : null,
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          ...FILTERS.map(f => jsx('button', {
            type: 'button',
            disabled: bulkBusy,
            onClick: () => { if (!bulkBusy) { setFilter(f.id); setPage(1); setSelected(null); setChecked([]) } },
            className: 'rounded px-2 py-0.5 text-[0.6875rem]',
            style: {
              ...BORDER,
              ...(filter === f.id ? { color: 'var(--ui-accent)' } : MUTED),
              ...(bulkBusy ? { opacity: 0.45, cursor: 'not-allowed' } : undefined)
            },
            children: f.label
          }, f.id)),
          !selecting && items.length > 0 && !decisionsOff
            ? jsx('button', {
              type: 'button',
              'data-wr-select': '',
              onClick: () => { refocusAfterSelect.current = true; setSelected(null); setChecked([]); setSelecting(true) },
              className: 'ml-auto rounded px-2 py-0.5 text-[0.6875rem]',
              style: { ...BORDER, ...MUTED },
              children: 'Select'
            })
            : null
        ].filter(Boolean)
      }),
      selecting && !failed && !list.isPending
        ? jsx(BulkBar, {
          pageCount: pageKeys.length,
          checkedCount: visibleChecked.length,
          allChecked,
          busy: bulkBusy,
          decisionsOff,
          onSelectAll: () => setChecked(allChecked ? [] : pageKeys),
          onReject: rejectSelected,
          onDone: exitSelecting
        })
        : null,
      body,
      data && data.total > data.page_size
        ? jsx(Pager, { data, disabled: bulkBusy, setPage: p => { if (!bulkBusy) { setChecked([]); setPage(p) } } })
        : null,
      // The dialog belongs to the scope it was opened in. ScopedPane remounts on a profile or gateway switch;
      // a failed list poll (no data) leaves an open review alone instead of closing it mid-read or mid-decision.
      !selecting && selected && (!data || selected.scope === data.scope)
        ? jsx(ReviewDialog, {
          ctx, profile, activation, connectionId, selected, refreshList: refreshLists,
          onClose: () => setSelected(null),
          restoreFocus
        }, JSON.stringify([selected.scope, selected.kind, selected.id]))
        : null
    ].filter(Boolean)
  })
}

// Core answers one page at a time; `total` counts every page.
function Pager({ data, disabled = false, setPage }) {
  const first = (data.page - 1) * data.page_size + 1
  const last = first + data.items.length - 1
  return jsxs('div', {
    className: 'flex items-center gap-1 text-[0.6875rem]',
    style: MUTED,
    children: [
      jsx('span', { className: 'mr-auto', children: `${first}–${last} of ${data.total}` }),
      jsx(Button, { variant: 'ghost', disabled: disabled || data.page <= 1, onClick: () => setPage(data.page - 1), children: 'Previous' }),
      jsx(Button, { variant: 'ghost', disabled: disabled || last >= data.total, onClick: () => setPage(data.page + 1), children: 'Next' })
    ]
  })
}

// The SDK can reveal a pane but not hide it, so this is not a toggle.
// Use the host's status-bar button classes so the styles are already compiled.
function PendingBadge({ ctx }) {
  const { failed, data } = usePendingList(ctx, useConnection(), 'all')
  const children = data ? `pending writes: ${data.counts.total}` : 'pending writes: –'
  if (typeof host.revealPane !== 'function') {
    return jsx('span', {
      className: 'px-1.5 text-[0.6875rem]',
      style: MUTED,
      title: failed ? failed.text : 'Staged memory/skill writes awaiting review',
      children
    })
  }
  return jsx('button', {
    type: 'button',
    'data-wr-badge': '',
    onClick: showPane,
    className: 'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] transition-colors '
      + 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
    title: failed ? failed.text : 'Show the Lesson review pane: staged memory/skill writes awaiting review',
    children
  })
}

export default {
  id: PLUGIN,
  // Must match the server and dashboard manifests for Desktop to pair the package halves.
  name: PLUGIN,
  defaultEnabled: false,
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: PANES_AREA,
      title: 'Lesson review',
      data: { placement: 'right', width: '320px' },
      render: () => jsx(PendingPane, { ctx })
    })
    ctx.register({
      id: 'badge',
      area: STATUSBAR_AREAS.right,
      order: 125,
      render: () => jsx(PendingBadge, { ctx })
    })
    // Leave default chords unbound so they don't collide with the host's shortcuts.
    if (typeof host.revealPane === 'function') {
      ctx.register({
        id: 'keybind-show',
        area: KEYBINDS_AREA,
        data: { id: SHOW_ACTION, category: 'view', label: 'Show Lesson review pane', defaults: [], run: showPane }
      })
      ctx.register({
        id: 'palette-show',
        area: PALETTE_AREA,
        data: {
          id: SHOW_ACTION,
          label: 'Lesson review: Show pending writes',
          action: SHOW_ACTION,
          keywords: ['lesson', 'review', 'pending', 'writes', 'memory', 'skills', 'approve', 'reject'],
          detail: pendingDetail,
          detailVariant: 'muted',
          run: showPane
        }
      })
    }
    ctx.register({
      id: 'keybind-refresh',
      area: KEYBINDS_AREA,
      data: { id: REFRESH_ACTION, category: 'view', label: 'Refresh Lesson review', defaults: [], run: refreshPendingNow }
    })
    ctx.register({
      id: 'palette-refresh',
      area: PALETTE_AREA,
      data: {
        id: REFRESH_ACTION,
        label: 'Lesson review: Refresh pending writes',
        action: REFRESH_ACTION,
        keywords: ['lesson', 'review', 'refresh', 'reload', 'pending', 'writes'],
        detail: pendingDetail,
        detailVariant: 'muted',
        run: refreshPendingNow
      }
    })
  }
}
