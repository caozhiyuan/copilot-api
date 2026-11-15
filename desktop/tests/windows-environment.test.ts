import { expect, mock, test } from 'bun:test'
import { createWindowsEnvironmentNotifierLoader } from '../electron/windows-environment'

type LoadLibrary = NonNullable<
  Parameters<typeof createWindowsEnvironmentNotifierLoader>[0]
>
type Send = ReturnType<Awaited<ReturnType<LoadLibrary>>['func']>['async']

function fixture() {
  const send = mock<Send>((...args) => args[7](null, 1))
  const func = mock((_definition: string) => ({ async: send }))
  const loadLibrary = mock<LoadLibrary>(() => Promise.resolve({ func }))
  const loadNotifier = createWindowsEnvironmentNotifierLoader(loadLibrary)
  return { send, func, loadLibrary, loadNotifier }
}

test('loads lazily, shares concurrent initialization, and reuses the native binding', async () => {
  const f = fixture()
  expect(f.loadLibrary).not.toHaveBeenCalled()
  const first = f.loadNotifier()
  const second = f.loadNotifier()
  expect(first).toBe(second)
  const notify = await first
  expect(await second).toBe(notify)
  expect(await notify()).toBe(true)
  expect(await (await f.loadNotifier())()).toBe(true)
  expect(f.loadLibrary).toHaveBeenCalledTimes(1)
  expect(f.func).toHaveBeenCalledTimes(1)
  expect(f.func.mock.calls[0][0]).toContain('SendMessageTimeoutW')
  expect(f.func.mock.calls[0][0]).toContain('str16')
  expect(f.send.mock.calls[0].slice(0, -1)).toEqual([
    0xffff,
    0x001a,
    0,
    'Environment',
    0x0022,
    1000,
    null,
  ])
})

test('waits asynchronously for the native callback', async () => {
  const f = fixture()
  let complete!: Parameters<Send>[7]
  f.send.mockImplementation((...args) => {
    complete = args[7]
  })
  let finished = false
  const pending = (await f.loadNotifier())().then((result) => {
    finished = true
    return result
  })
  await Promise.resolve()
  expect(finished).toBe(false)
  complete(null, 1)
  expect(await pending).toBe(true)
})

test('reports a native timeout or failure without assuming delivery succeeded', async () => {
  const f = fixture()
  f.send.mockImplementation((...args) => args[7](null, 0))
  expect(await (await f.loadNotifier())()).toBe(false)
})

test.each([new Error('native callback failure'), 'native callback failure'])(
  'propagates a native callback error as an Error',
  async (error) => {
    const f = fixture()
    f.send.mockImplementation((...args) => args[7](error, 0))
    await expect((await f.loadNotifier())()).rejects.toBeInstanceOf(Error)
  },
)

test.each([
  new Error('native invocation failure'),
  'native invocation failure',
])(
  'handles a synchronous native invocation error as an Error',
  async (error) => {
    const f = fixture()
    f.send.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise an untyped native dependency throwing a non-Error value.
      throw error
    })
    await expect((await f.loadNotifier())()).rejects.toBeInstanceOf(Error)
  },
)

test('allows retrying a failed native initialization', async () => {
  const f = fixture()
  f.loadLibrary.mockRejectedValueOnce(new Error('load failed'))
  await expect(f.loadNotifier()).rejects.toThrow('load failed')
  expect(await (await f.loadNotifier())()).toBe(true)
  expect(f.loadLibrary).toHaveBeenCalledTimes(2)
})

test('bounds the total broadcast wait and tolerates a late callback', async () => {
  const f = fixture()
  let complete!: Parameters<Send>[7]
  f.send.mockImplementation((...args) => {
    complete = args[7]
  })
  expect(await (await f.loadNotifier())()).toBe(false)
  complete(null, 1)
})
