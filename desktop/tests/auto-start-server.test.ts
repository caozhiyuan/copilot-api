import { expect, test } from 'bun:test'

import { autoStartServer } from '../src/lib/auto-start-server'

const settings = {
  autoStartServer: true,
  lastPort: 5151,
}

test('auto-starts only after authorization loads', async () => {
  const calls: unknown[] = []
  const startServer = async (...args: unknown[]) => {
    calls.push(args)
    return { running: true, port: 5151 }
  }

  expect(
    await autoStartServer(
      { ...settings, autoStartServer: false },
      { success: true, mode: 'copilot' },
      startServer,
    ),
  ).toBeUndefined()
  expect(
    await autoStartServer(
      settings,
      { success: false, mode: 'none' },
      startServer,
    ),
  ).toBeUndefined()
  expect(
    await autoStartServer(
      settings,
      { success: true, mode: 'provider' },
      startServer,
    ),
  ).toEqual({ running: true, port: 5151 })
  expect(calls).toEqual([[5151, 'provider']])
})

test('returns startup errors for the dashboard to display', async () => {
  expect(
    await autoStartServer(settings, { success: true, mode: 'copilot' }, () =>
      Promise.reject(new Error('startup failed')),
    ),
  ).toEqual({ running: false, error: 'startup failed' })
})
