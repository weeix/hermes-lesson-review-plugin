// Stand-in for '@hermes/plugin-sdk' in the render smoke test (tests/render/run.mjs). Static: no backend
// data is written into code. Query results come from globalThis.__WR_QUERIES__ (a Map from
// JSON.stringify(queryKey) to an entry), set per scenario by run.mjs:
//   { data }              success
//   { error, stale? }     failed; `stale` is the data react-query keeps from an earlier success
//   { pending: true }     still loading
// Only the SDK surface the plugin uses is here. Button mirrors apps/desktop's ui/button (variant and
// disabled props, data-slot); Dialog* stand in for apps/desktop's ui/dialog (Radix): the real Dialog
// portals to document.body, this one renders the content in place when open and nothing when closed.
// Tailwind classes are NOT reproduced.
import { jsx, jsxs } from 'react/jsx-runtime'

export const KEYBINDS_AREA = 'keybinds'
export const PALETTE_AREA = 'palette'
export const PANES_AREA = 'panes'
export const STATUSBAR_AREAS = { right: 'statusBar.right' }
// notify() records the toast; the real host shows it in the notification stack.
export const host = {
  state: {
    profile: { get: () => globalThis.__WR_PROFILE__ },
    connectionId: { get: () => globalThis.__WR_CONNECTION__ ?? 'local' },
    focusedSessionId: { get: () => globalThis.__WR_SESSION_ID__ ?? null },
    focusedStoredSessionId: { get: () => globalThis.__WR_STORED_SESSION_ID__ ?? null },
    focusedSessionProfile: { get: () => globalThis.__WR_SESSION_PROFILE__ ?? globalThis.__WR_PROFILE__ },
    // `__WR_SESSION_OWNER__`: an owner object, or null for unknown; unset = this connection and profile.
    focusedSessionOwner: {
      get: () => (globalThis.__WR_SESSION_OWNER__ !== undefined ? globalThis.__WR_SESSION_OWNER__
        : { connectionId: globalThis.__WR_CONNECTION__ ?? 'local', profile: globalThis.__WR_SESSION_PROFILE__ ?? globalThis.__WR_PROFILE__ })
    }
  },
  // The composer verbs record what they were asked; `__WR_DRAFT__` is the input's text, and
  // `__WR_SET_DRAFT_OK__ === false` makes setDraft report that no input answered.
  composer: {
    async getDraft(sessionId) {
      ;(globalThis.__WR_COMPOSER__ ||= []).push({ op: 'getDraft', sessionId })
      globalThis.__WR_ON_GET_DRAFT__?.()
      return globalThis.__WR_DRAFT__ ?? ''
    },
    submit(sessionId, text) {
      ;(globalThis.__WR_COMPOSER__ ||= []).push({ op: 'submit', sessionId, text })
      return true
    },
    async setDraft(sessionId, text) {
      ;(globalThis.__WR_COMPOSER__ ||= []).push({ op: 'setDraft', sessionId, text })
      return globalThis.__WR_SET_DRAFT_OK__ !== false
    },
    focus(sessionId) {
      ;(globalThis.__WR_COMPOSER__ ||= []).push({ op: 'focus', sessionId })
    }
  },
  paneVisibility() {
    return { get: () => globalThis.__WR_PANE_VISIBLE__ ?? true }
  },
  // Records the pane ids it was asked to reveal.
  revealPane(paneId) {
    ;(globalThis.__WR_REVEALS__ ||= []).push(paneId)
  },
  // Listeners by event type in `__WR_LISTENERS__`, so a test can emit gateway events.
  onEvent(type, handler) {
    const map = (globalThis.__WR_LISTENERS__ ||= new Map())
    let set = map.get(type)
    if (!set) { set = new Set(); map.set(type, set) }
    set.add(handler)
    return () => set.delete(handler)
  },
  notify(input) {
    ;(globalThis.__WR_TOASTS__ ||= []).push(input)
  }
}
export const gatewayActivationEpoch = () => globalThis.__WR_ACTIVATION__ ?? 1
export const useGatewayActivationEpoch = gatewayActivationEpoch

export function useValue(atom) {
  return atom.get()
}

export function useQuery({ queryKey }) {
  const key = JSON.stringify(queryKey)
  const entry = globalThis.__WR_QUERIES__?.get(key)
  if (!entry) {
    return { isPending: false, isError: true, error: new Error(`no mock for ${key}`), data: undefined, refetch() {} }
  }
  if (entry.pending) return { isPending: true, isError: false, data: undefined, refetch() {} }
  if (entry.error) return { isPending: false, isError: true, error: entry.error, data: entry.stale, refetch() {} }
  return { isPending: false, isError: false, data: entry.data, refetch() {} }
}

// The static render never decides, so nothing is invalidated.
export const useQueryClient = () => ({ invalidateQueries() {} })

export function Button(props) {
  const { children, variant = 'default', disabled = false, ...rest } = props
  return jsx('button', { ...rest, type: 'button', disabled, 'data-slot': 'button', 'data-variant': variant, children })
}

export function Dialog({ open, children }) {
  return open ? children : null
}

// Props meant for Radix (focus and dismissal handlers) are ignored here; focus.mjs runs the real Dialog.
export function DialogContent({ children, chrome, style }) {
  return jsxs('div', {
    role: 'dialog',
    'data-slot': 'dialog-content',
    style,
    children: [
      jsx('div', { 'data-slot': 'dialog-body', children }),
      chrome ?? null,
      jsx('button', { type: 'button', 'aria-label': 'Close', 'data-slot': 'dialog-close-button' })
    ].filter(node => node !== null)
  })
}

export function DialogHeader({ style, children }) {
  return jsx('div', { 'data-slot': 'dialog-header', style, children })
}

export function DialogTitle({ children }) {
  return jsx('h2', { 'data-slot': 'dialog-title', children })
}

export function DialogDescription({ children }) {
  return jsx('p', { 'data-slot': 'dialog-description', children })
}
