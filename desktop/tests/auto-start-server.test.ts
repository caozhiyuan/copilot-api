import { expect, test } from 'bun:test'

import { autoStartServer } from '../src/lib/auto-start-server'

const settings = {
  autoStartServer: true,
  lastPort: 5151,
  host: '',
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
  expect(calls).toEqual([[5151, 'provider', '']])
})

test('passes the saved host when auto-starting', async () => {
  const calls: unknown[] = []
  const startServer = async (...args: unknown[]) => {
    calls.push(args)
    return { running: true, port: 5151 }
  }

  await autoStartServer(
    { ...settings, host: '0.0.0.0' },
    { success: true, mode: 'copilot' },
    startServer,
  )
  expect(calls).toEqual([[5151, 'copilot', '0.0.0.0']])
})

test('returns startup errors for the dashboard to display', async () => {
  expect(
    await autoStartServer(settings, { success: true, mode: 'copilot' }, () =>
      Promise.reject(new Error('startup failed')),
    ),
  ).toEqual({ running: false, error: 'startup failed' })
})

test('reuses an already-running server without restarting it', async () => {
  const calls: unknown[] = []
  const startServer = async (...args: unknown[]) => {
    calls.push(args)
    return { running: true, port: 5151 }
  }

  expect(
    await autoStartServer(
      settings,
      { success: true, mode: 'copilot' },
      startServer,
      async () => ({ running: true, port: 6060, host: '127.0.0.1' }),
    ),
  ).toEqual({ running: true, port: 6060, host: '127.0.0.1' })
  expect(calls).toEqual([])

  // Starts normally when the status query reports stopped or fails.
  expect(
    await autoStartServer(
      settings,
      { success: true, mode: 'copilot' },
      startServer,
      async () => ({ running: false }),
    ),
  ).toEqual({ running: true, port: 5151 })
  expect(
    await autoStartServer(
      settings,
      { success: true, mode: 'copilot' },
      startServer,
      () => Promise.reject(new Error('status failed')),
    ),
  ).toEqual({ running: true, port: 5151 })
  expect(calls).toHaveLength(2)
})
