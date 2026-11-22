// Preserve the host dialog's structure, not its Tailwind skin, so focus tests exercise Radix.
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
