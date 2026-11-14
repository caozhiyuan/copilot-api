import { expect, test } from 'bun:test'

import { createDefaultSettings } from '../shared/default-settings'

test('default settings do not share mutable proxy state', () => {
  const first = createDefaultSettings()
  first.verbose = true
  first.proxy.mode = 'direct'

  const next = createDefaultSettings()
  expect(next).not.toBe(first)
  expect(next.proxy).not.toBe(first.proxy)
  expect(next.verbose).toBe(false)
  expect(next.proxy.mode).toBe('system')
})
