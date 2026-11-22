// sdk-live.mjs (the stub with the host's react-query) plus the host's real dialog: Radix Dialog from
// 'radix-ui' 1.7.0 (apps/desktop/package.json; @radix-ui/react-dialog 1.2.0, as in Desktop's lockfile). DialogContent mirrors
// apps/desktop/src/components/ui/dialog.tsx structurally (Portal > Overlay + Content > body, chrome, close
// button; extra props such as onCloseAutoFocus pass through to Radix) without its Tailwind skin.
// Used by focus.mjs, where real focus management matters.
import { Dialog as D } from 'radix-ui'
import { jsx, jsxs } from 'react/jsx-runtime'

export * from './sdk-live.mjs'

export const Dialog = D.Root
export const DialogTitle = D.Title
export const DialogDescription = D.Description

export function DialogContent({ children, chrome, ...props }) {
  return jsxs(D.Portal, {
    children: [
      jsx(D.Overlay, {}),
      jsxs(D.Content, {
        'data-slot': 'dialog-content',
        ...props,
        children: [
          jsx('div', { 'data-slot': 'dialog-body', children }),
          chrome ?? null,
          jsx(D.Close, { 'aria-label': 'Close dialog', children: '×' })
        ]
      })
    ]
  })
}
