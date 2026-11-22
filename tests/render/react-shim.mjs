// Stands in for 'react' in the generated copy of desktop/plugin.js (tests/render/run.mjs). Only useState
// differs: a null initial value takes globalThis.__WR_PRESELECT__ when set, so a test can open the review
// dialog on a chosen record without generating any code.
import React from 'react'

export function useState(initial) {
  const preset = globalThis.__WR_PRESELECT__
  return React.useState(initial === null && preset ? preset : initial)
}

export { useEffect, useRef } from 'react'
