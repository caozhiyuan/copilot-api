import {
  beforeEach,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PATHS } from '../../src/lib/paths'
import { VIDEO_IMAGE_MAX_BYTES } from '../electron/compress-video-image'

import * as serverAuth from '../electron/server-auth-config'
import * as settingsStore from '../electron/settings-store'
import * as providerManagement from '../../src/lib/provider-management'
import { CodexOAuthError } from '../../src/lib/oauth/codex'
import { XaiOAuthError } from '../../src/lib/oauth/xai'
import * as xaiToken from '../../src/lib/xai-token'
import type {
  AppConfigDocument,
  AppConfigSaveResult,
  DesktopSettings,
  ServerKeysConfigUpdate,
  XaiAuthInfo,
} from '../src/types/ipc'

type IpcHandler = (event: unknown, ...parameters: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const openExternal = mock(() => Promise.resolve())
let saveDialogResult: { canceled: boolean; filePath?: string } = {
  canceled: true,
}
const showSaveDialog = mock(() => Promise.resolve(saveDialogResult))
let preloadApi: Window['electronAPI'] | undefined
type RendererListener = (event: unknown, payload: unknown) => void
const rendererListeners = new Map<string, Set<RendererListener>>()
const rendererOff = mock((channel: string, listener: RendererListener) => {
  const listeners = rendererListeners.get(channel)
  listeners?.delete(listener)
  if (listeners?.size === 0) rendererListeners.delete(channel)
})
const rendererInvoke = mock(
  (_channel: string, ..._args: unknown[]): Promise<unknown> =>
    Promise.resolve(),
)
let running = true
let activeAdminApiKey = 'old-admin'
let keys = { apiKeys: ['old-api'], adminApiKey: 'old-admin' }
let settings: DesktopSettings
let restartError: string | undefined
const startServer = mock((port: number, options?: { host?: string }) => {
  if (restartError) {
    return Promise.resolve({ running: false, error: restartError })
  }
  running = true
  activeAdminApiKey = keys.adminApiKey
  return Promise.resolve({ running: true, port, host: options?.host })
})

await mock.module('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Window['electronAPI']) => {
      preloadApi = api
    },
  },
  ipcRenderer: {
    invoke: rendererInvoke,
    on: (channel: string, listener: RendererListener) => {
      const listeners =
        rendererListeners.get(channel) ?? new Set<RendererListener>()
      listeners.add(listener)
      rendererListeners.set(channel, listeners)
    },
    off: rendererOff,
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) =>
      handlers.set(channel, handler),
    on: () => {},
  },
  shell: { openExternal },
  dialog: { showSaveDialog },
  BrowserWindow: class {},
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 8, height: 8 }),
      resize: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 8, height: 8 }),
        toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    }),
  },
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isReady: () => true,
    getLocale: () => 'en',
  },
  utilityProcess: {},
}))
await mock.module('../electron/server-manager', () => ({
  isRunning: () => running,
  startServer,
  stopServer: () => {
    running = false
    return Promise.resolve()
  },
  getPort: () => 4141,
  getHost: () => '127.0.0.1',
  getServerBaseUrl: () => 'http://127.0.0.1:4141',
  getLogs: () => [],
}))

const { registerIpcHandlers } = await import('../electron/ipc-handlers')
const auth = await import('../electron/auth')
const providerAuth = await import('../electron/provider-auth')

async function invoke(
  channel: string,
  ...parameters: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Unknown IPC channel: ${channel}`)
  return await handler(undefined, ...parameters)
}

beforeEach(async () => {
  handlers.clear()
  openExternal.mockClear()
  showSaveDialog.mockClear()
  saveDialogResult = { canceled: true }
  rendererListeners.clear()
  rendererOff.mockClear()
  rendererInvoke.mockClear()
  keys = { apiKeys: ['old-api'], adminApiKey: 'old-admin' }
  activeAdminApiKey = keys.adminApiKey
  settings = settingsStore.normalizeSettings({})
  restartError = undefined
  startServer.mockClear()
  spyOn(serverAuth, 'readServerKeysConfig').mockImplementation(() =>
    Promise.resolve(structuredClone(keys)),
  )
  spyOn(serverAuth, 'writeServerKeysConfig').mockImplementation(
    (update: ServerKeysConfigUpdate) => {
      keys = {
        apiKeys: update.apiKeys ?? keys.apiKeys,
        adminApiKey:
          update.adminApiKey === undefined ?
            keys.adminApiKey
          : (update.adminApiKey ?? ''),
      }
      return structuredClone(keys)
    },
  )
  spyOn(settingsStore, 'readSettings').mockImplementation(() =>
    Promise.resolve(structuredClone(settings)),
  )
  spyOn(settingsStore, 'writeSettings').mockImplementation((update) => {
    settings = structuredClone(update)
    return Promise.resolve()
  })
  spyOn(providerManagement, 'saveProviderManagementConfig').mockReturnValue({
    configPath: 'test-config.json',
    providers: [],
  })
  const result = {
    success: true,
    mode: 'provider' as const,
    providers: ['codex'],
  }
  spyOn(providerAuth, 'configureProviderWithAuthStatus').mockResolvedValue(
    result,
  )
  spyOn(providerAuth, 'selectCodexAccountForDesktop').mockResolvedValue(result)
  spyOn(providerAuth, 'removeCodexAccountForDesktop').mockResolvedValue(result)
  spyOn(providerAuth, 'loginCodexForDesktop').mockResolvedValue(result)
  spyOn(providerAuth, 'loginXaiForDesktop').mockResolvedValue({
    ...result,
    providers: ['xai'],
  })
  spyOn(xaiToken, 'getXaiAccounts').mockResolvedValue([])
  spyOn(xaiToken, 'selectXaiAccount').mockResolvedValue({
    accountId: 'account-id',
    active: true,
  })
  spyOn(xaiToken, 'removeXaiAccount').mockResolvedValue({
    accountId: 'account-id',
    active: false,
  })
  spyOn(auth, 'getGitHubUser').mockResolvedValue('test-user')
  spyOn(auth, 'getCopilotAccountType').mockResolvedValue('individual')
  spyOn(auth, 'saveToken').mockResolvedValue(undefined)
  spyOn(auth, 'clearToken').mockResolvedValue(undefined)
  spyOn(auth, 'readToken').mockResolvedValue(null)
  spyOn(providerAuth, 'getEnabledDesktopProviders').mockReturnValue(['codex'])
  const fetchResponse = Object.assign(
    (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      const adminApiKey = new Headers(options?.headers).get('x-api-key')
      if (adminApiKey !== activeAdminApiKey) {
        return Promise.resolve(
          Response.json(
            { error: { message: 'Unauthorized' } },
            { status: 401 },
          ),
        )
      }
      keys.adminApiKey ||= 'regenerated-admin'
      activeAdminApiKey = keys.adminApiKey
      return Promise.resolve(Response.json({ reloaded: true }))
    },
    { preconnect: () => {} },
  )
  spyOn(globalThis, 'fetch').mockImplementation(fetchResponse)
  registerIpcHandlers({ once: () => {} } as unknown as BrowserWindow)
  running = false
  await invoke('config:save-provider-management', {})
  running = true
})

afterEach(() => mock.restore())

describe('desktop model discovery IPC', () => {
  test('requests image models for the Dashboard with gateway auth and preserves the catalog', async () => {
    spyOn(fs.promises, 'readFile').mockResolvedValue(
      JSON.stringify({ auth: { apiKeys: ['models-key'] } }),
    )
    const catalog = {
      object: 'list',
      data: [
        { id: 'codex/gpt-image-2', type: 'image' },
        { id: 'xai/grok-imagine-image-2.0', type: 'image' },
      ],
    }
    const fetcher = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(catalog),
    )
    expect(await invoke('server:fetch-models')).toEqual(catalog)
    expect(fetcher).toHaveBeenLastCalledWith(
      'http://127.0.0.1:4141/models',
      expect.objectContaining({
        headers: { 'x-api-key': 'models-key' },
      }),
    )
    expect(fetcher.mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('desktop subscription quota IPC', () => {
  test('requests CLI server quotas with gateway auth', async () => {
    spyOn(fs.promises, 'readFile').mockResolvedValue(
      JSON.stringify({ auth: { apiKeys: ['quota-key'] } }),
    )
    const usage = {
      provider: 'codex',
      planType: 'business',
      windows: [],
      limitReached: false,
    }
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(() => Promise.resolve(Response.json(usage)), {
        preconnect: () => {},
      }),
    )
    expect(await invoke('server:fetch-subscription-usage', 'codex')).toEqual(
      usage,
    )
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4141/usage/codex',
      expect.objectContaining({
        headers: { 'x-api-key': 'quota-key' },
      }),
    )
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    expect(await invoke('server:fetch-subscription-usage', 'xai')).toEqual(
      usage,
    )
    expect(fetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:4141/usage/xai',
      expect.anything(),
    )
    expect(
      await invoke('server:fetch-subscription-usage', 'opencode-go'),
    ).toEqual(usage)
    expect(fetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:4141/usage/opencode-go',
      expect.objectContaining({ headers: { 'x-api-key': 'quota-key' } }),
    )
  })

  test('distinguishes unavailable accounts from failed requests and validates the provider', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    )
    expect(await invoke('server:fetch-subscription-usage', 'codex')).toBeNull()
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('private-upstream-error', { status: 502 }),
    )
    await expect(
      invoke('server:fetch-subscription-usage', 'xai'),
    ).rejects.toThrow('Failed to fetch subscription usage')
    await expect(
      invoke('server:fetch-subscription-usage', '../admin/config'),
    ).rejects.toThrow('Unsupported subscription provider')
    spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'))
    await expect(
      invoke('server:fetch-subscription-usage', 'codex'),
    ).rejects.toThrow('offline')
  })

  test('exposes typed quota queries through preload', async () => {
    await import('../electron/preload')
    if (!preloadApi) throw new Error('Preload bridge was not exposed')
    await preloadApi.fetchSubscriptionUsage('codex')
    expect(rendererInvoke).toHaveBeenCalledWith(
      'server:fetch-subscription-usage',
      'codex',
    )
    await preloadApi.fetchSubscriptionUsage('xai')
    expect(rendererInvoke).toHaveBeenLastCalledWith(
      'server:fetch-subscription-usage',
      'xai',
    )
    await preloadApi.fetchSubscriptionUsage('opencode-go')
    expect(rendererInvoke).toHaveBeenLastCalledWith(
      'server:fetch-subscription-usage',
      'opencode-go',
    )
  })
})

describe('desktop media IPC', () => {
  const imageInput = {
    mode: 'generate',
    provider: 'default',
    model: 'gpt-image-2',
    prompt: 'A boat',
    size: 'auto',
    quality: 'auto',
    n: 1,
    images: [],
  }
  test('exposes image, video, cancel and save calls through the preload', async () => {
    await import('../electron/preload')
    if (!preloadApi) throw new Error('Preload bridge was not exposed')
    await preloadApi.createImages('image-call', {
      ...imageInput,
      mode: 'generate',
      provider: 'default',
      size: 'auto',
      quality: 'auto',
    })
    await preloadApi.createVideo('video-call', {
      prompt: 'A boat',
      duration: 8,
      aspectRatio: '16:9',
      resolution: '720p',
      generateAudio: true,
    })
    await preloadApi.getVideo('poll-call', 'video-job')
    await preloadApi.cancelMediaRequest('image-call')
    await preloadApi.saveMedia({
      kind: 'image',
      url: 'data:image/png;base64,iVBORw==',
    })
    expect(rendererInvoke.mock.calls.map((call) => call[0])).toEqual([
      'media:create-images',
      'media:create-video',
      'media:get-video',
      'media:cancel',
      'media:save',
    ])
  })
  test('runs image and video requests through the main-process client', async () => {
    const fetchMock = spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ b64_json: 'iVBORw==' }] }),
    )
    expect(
      await invoke('media:create-images', 'image-call', imageInput),
    ).toEqual([{ url: 'data:image/png;base64,iVBORw==' }])
    fetchMock.mockResolvedValueOnce(Response.json({ request_id: 'video-job' }))
    expect(
      await invoke('media:create-video', 'video-call', {
        prompt: 'A boat',
        duration: 8,
        aspectRatio: '16:9',
        resolution: '720p',
        generateAudio: true,
      }),
    ).toMatchObject({ requestId: 'video-job', status: 'pending' })
    fetchMock.mockResolvedValueOnce(Response.json({ request_id: 'compressed' }))
    await invoke('media:create-video', 'large-video', {
      prompt: 'A boat',
      duration: 8,
      aspectRatio: '16:9',
      resolution: '720p',
      generateAudio: true,
      image: {
        name: 'frame.png',
        type: 'image/png',
        bytes: new Uint8Array(VIDEO_IMAGE_MAX_BYTES + 1),
      },
    })
    expect(
      JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string),
    ).toHaveProperty('image.url', 'data:image/jpeg;base64,/9j/2Q==')
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: 'done',
        video: { url: 'https://vidgen.x.ai/a.mp4' },
      }),
    )
    expect(
      await invoke('media:get-video', 'poll-call', 'video-job'),
    ).toMatchObject({ status: 'done' })
    await invoke('media:cancel', 'already-finished')
    running = false
    await expect(
      invoke('media:create-images', 'stopped-call', imageInput),
    ).rejects.toThrow('Start the server')
  })
  test('honors cancelled save dialogs and saves base64 images without a network fetch', async () => {
    const input = { kind: 'image', url: 'data:image/png;base64,iVBORw==' }
    expect(await invoke('media:save', input)).toBe(false)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ipc-'))
    try {
      saveDialogResult = {
        canceled: false,
        filePath: path.join(directory, 'image.png'),
      }
      expect(await invoke('media:save', input)).toBe(true)
      expect(Array.from(fs.readFileSync(saveDialogResult.filePath!))).toEqual([
        137, 80, 78, 71,
      ])
      expect(showSaveDialog).toHaveBeenCalledTimes(2)
      await expect(
        invoke('media:save', { kind: 'image', url: 'file:///etc/passwd' }),
      ).rejects.toThrow()
      expect(showSaveDialog).toHaveBeenCalledTimes(2)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('desktop Codex login controls', () => {
  test('exposes cancellation and URL subscription through the preload bridge', async () => {
    await import('../electron/preload')
    if (!preloadApi) throw new Error('Preload bridge was not exposed')
    const callback = mock((_url: string) => {})
    const unsubscribe = preloadApi.onCodexAuthUrl(callback)
    const handler = [...rendererListeners.get('auth:codex-url')!][0]
    const otherCallback = mock((_url: string) => {})
    const unsubscribeOther = preloadApi.onCodexAuthUrl(otherCallback)
    for (const listener of rendererListeners.get('auth:codex-url')!) {
      listener(undefined, 'https://auth.example/login')
    }
    expect(callback).toHaveBeenCalledWith('https://auth.example/login')
    unsubscribe()
    expect(rendererOff).toHaveBeenCalledWith('auth:codex-url', handler)
    expect(rendererListeners.get('auth:codex-url')?.size).toBe(1)
    for (const listener of rendererListeners.get('auth:codex-url')!) {
      listener(undefined, 'https://auth.example/second')
    }
    expect(callback).toHaveBeenCalledTimes(1)
    expect(otherCallback).toHaveBeenCalledTimes(2)
    unsubscribeOther()
    expect(rendererListeners.has('auth:codex-url')).toBe(false)
    const onSaving = mock(() => {})
    const unsubscribeSaving = preloadApi.onCodexLoginSaving(onSaving)
    const savingHandler = [...rendererListeners.get('auth:codex-saving')!][0]
    savingHandler(undefined, '')
    expect(onSaving).toHaveBeenCalledTimes(1)
    unsubscribeSaving()
    expect(rendererOff).toHaveBeenCalledWith('auth:codex-saving', savingHandler)
    await preloadApi.cancelCodexLogin()
    expect(rendererInvoke).toHaveBeenCalledWith('auth:cancel-codex-login')
    await preloadApi.startCodexLogin({ alias: 'Work' })
    expect(rendererInvoke).toHaveBeenCalledWith('auth:start-codex-login', {
      alias: 'Work',
    })
  })

  test('publishes the URL without opening the browser and cancels the active login', async () => {
    const notifications = mock((_channel: string, _url: string) => {})
    registerIpcHandlers({
      once: () => {},
      isDestroyed: () => false,
      webContents: { send: notifications },
    } as unknown as BrowserWindow)
    const started = Promise.withResolvers<AbortSignal>()
    spyOn(providerAuth, 'loginCodexForDesktop').mockImplementation(
      (options) => {
        options.onAuthUrl?.('https://auth.example/login')
        const signal = options.signal!
        started.resolve(signal)
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason as Error),
            {
              once: true,
            },
          )
        })
      },
    )
    const pending = invoke('auth:start-codex-login')
    const signal = await started.promise
    expect(notifications).toHaveBeenCalledWith(
      'auth:codex-url',
      'https://auth.example/login',
    )
    expect(openExternal).not.toHaveBeenCalled()
    expect(await invoke('auth:start-codex-login')).toMatchObject({
      success: false,
      error: 'Codex sign-in is already in progress.',
    })
    await invoke('auth:cancel-codex-login')
    expect(signal.aborted).toBe(true)
    expect(await pending).toEqual({
      success: false,
      mode: 'none',
      cancelled: true,
    })
    expect(fetch).not.toHaveBeenCalled()

    spyOn(providerAuth, 'loginCodexForDesktop').mockResolvedValue({
      success: true,
      mode: 'provider',
    })
    expect(await invoke('auth:start-codex-login')).toMatchObject({
      success: true,
    })
    await invoke('auth:cancel-codex-login')
  })

  test('reports login failures and allows another attempt', async () => {
    spyOn(providerAuth, 'loginCodexForDesktop').mockRejectedValueOnce(
      new Error('Missing Codex authorization code'),
    )
    expect(await invoke('auth:start-codex-login')).toMatchObject({
      success: false,
      error: 'Missing Codex authorization code',
    })
    expect(await invoke('auth:start-codex-login')).toMatchObject({
      success: true,
    })
  })

  test('waits for cancelled callback cleanup before starting a new login', async () => {
    const first =
      Promise.withResolvers<
        Awaited<ReturnType<typeof providerAuth.loginCodexForDesktop>>
      >()
    const started = Promise.withResolvers<AbortSignal>()
    const login = spyOn(
      providerAuth,
      'loginCodexForDesktop',
    ).mockImplementationOnce((options) => {
      started.resolve(options.signal)
      return first.promise
    })
    const pending = invoke('auth:start-codex-login')
    const signal = await started.promise
    const cancellation = invoke('auth:cancel-codex-login')
    const next = invoke('auth:start-codex-login', { alias: 'Next' })
    expect(signal.aborted).toBe(true)
    expect(login).toHaveBeenCalledTimes(1)
    first.reject(signal.reason as Error)
    expect(await pending).toMatchObject({ cancelled: true })
    expect(await cancellation).toBe(true)
    expect(await next).toMatchObject({ success: true })
    expect(login).toHaveBeenCalledTimes(2)
    expect(login).toHaveBeenLastCalledWith(
      expect.objectContaining({ alias: 'Next' }),
    )
  })

  test.each([false, true])(
    'finishes persistence and preserves the refresh outcome (fails: %s)',
    async (fails) => {
      const refresh = Promise.withResolvers<Response>()
      const refreshing = Promise.withResolvers<void>()
      const notifications = mock((_channel: string) => {})
      registerIpcHandlers({
        once: () => {},
        isDestroyed: () => false,
        webContents: { send: notifications },
      } as unknown as BrowserWindow)
      let signal: AbortSignal | undefined
      const login = spyOn(
        providerAuth,
        'loginCodexForDesktop',
      ).mockImplementationOnce((options) => {
        signal = options.signal
        options.onSaving?.()
        return Promise.resolve({
          success: true,
          mode: 'provider',
          providers: ['codex'],
        })
      })
      spyOn(globalThis, 'fetch').mockImplementationOnce(
        Object.assign(
          () => {
            refreshing.resolve()
            return refresh.promise
          },
          { preconnect: () => {} },
        ),
      )
      const pending = invoke('auth:start-codex-login')
      await refreshing.promise
      expect(notifications).toHaveBeenCalledWith('auth:codex-saving')
      expect(await invoke('auth:cancel-codex-login')).toBe(false)
      expect(signal?.aborted).toBe(false)
      const next = invoke('auth:start-codex-login')
      expect(login).toHaveBeenCalledTimes(1)
      if (fails) refresh.reject(new Error('connection failed'))
      else refresh.resolve(Response.json({ reloaded: true }))
      if (fails) {
        expect(await pending).toEqual({
          success: false,
          mode: 'none',
          error: 'Configuration saved, but refresh failed: connection failed',
        })
      } else {
        expect(await pending).toMatchObject({ success: true })
      }
      expect(await next).toMatchObject({ success: true })
      expect(login).toHaveBeenCalledTimes(2)
    },
  )

  test('does not hide an unrelated failure when cancellation races with it', async () => {
    const failure =
      Promise.withResolvers<
        Awaited<ReturnType<typeof providerAuth.loginCodexForDesktop>>
      >()
    const started = Promise.withResolvers<void>()
    spyOn(providerAuth, 'loginCodexForDesktop').mockImplementationOnce(() => {
      started.resolve()
      return failure.promise
    })
    const pending = invoke('auth:start-codex-login')
    await started.promise
    const cancellation = invoke('auth:cancel-codex-login')
    failure.reject(new Error('Persistence failed'))
    expect(await pending).toEqual({
      success: false,
      mode: 'none',
      error: 'Persistence failed',
    })
    await cancellation
  })

  test('can cancel a queued login without cancelling the previous saved login', async () => {
    const refresh = Promise.withResolvers<Response>()
    const refreshing = Promise.withResolvers<void>()
    registerIpcHandlers({
      once: () => {},
      isDestroyed: () => false,
      webContents: { send: () => {} },
    } as unknown as BrowserWindow)
    const login = spyOn(
      providerAuth,
      'loginCodexForDesktop',
    ).mockImplementationOnce((options) => {
      options.onSaving?.()
      return Promise.resolve({ success: true, mode: 'provider' })
    })
    spyOn(globalThis, 'fetch').mockImplementationOnce(
      Object.assign(
        () => {
          refreshing.resolve()
          return refresh.promise
        },
        { preconnect: () => {} },
      ),
    )
    const previous = invoke('auth:start-codex-login')
    await refreshing.promise
    const queued = invoke('auth:start-codex-login', { alias: 'Cancelled' })
    expect(await invoke('auth:cancel-codex-login')).toBe(true)
    const next = invoke('auth:start-codex-login', { alias: 'Next' })
    expect(login).toHaveBeenCalledTimes(1)
    refresh.resolve(Response.json({ reloaded: true }))
    expect(await previous).toMatchObject({ success: true })
    expect(await queued).toMatchObject({ cancelled: true })
    expect(await next).toMatchObject({ success: true })
    expect(login).toHaveBeenCalledTimes(2)
    expect(login).toHaveBeenLastCalledWith(
      expect.objectContaining({ alias: 'Next' }),
    )
  })

  test('recognizes a fetch AbortError as cancellation before saving', async () => {
    const failure =
      Promise.withResolvers<
        Awaited<ReturnType<typeof providerAuth.loginCodexForDesktop>>
      >()
    const started = Promise.withResolvers<void>()
    spyOn(providerAuth, 'loginCodexForDesktop').mockImplementationOnce(() => {
      started.resolve()
      return failure.promise
    })
    const pending = invoke('auth:start-codex-login')
    await started.promise
    expect(await invoke('auth:cancel-codex-login')).toBe(true)
    failure.reject(new DOMException('The operation was aborted', 'AbortError'))
    expect(await pending).toMatchObject({ cancelled: true })
  })

  test.each([
    ['callback_timeout', '授权已超过 2 分钟'],
    ['callback_unavailable', '端口 1455'],
  ] as const)(
    'localizes %s and keeps retry available',
    async (reason, message) => {
      settings.language = 'zh'
      spyOn(providerAuth, 'loginCodexForDesktop').mockRejectedValueOnce(
        new CodexOAuthError(reason),
      )
      expect(await invoke('auth:start-codex-login')).toMatchObject({
        success: false,
        error: expect.stringContaining(message) as string,
      })
      expect(await invoke('auth:start-codex-login')).toMatchObject({
        success: true,
      })
    },
  )

  test('localizes duplicate active logins', async () => {
    settings.language = 'zh'
    const first =
      Promise.withResolvers<
        Awaited<ReturnType<typeof providerAuth.loginCodexForDesktop>>
      >()
    const started = Promise.withResolvers<void>()
    spyOn(providerAuth, 'loginCodexForDesktop').mockImplementationOnce(() => {
      started.resolve()
      return first.promise
    })
    const pending = invoke('auth:start-codex-login')
    await started.promise
    expect(await invoke('auth:start-codex-login')).toMatchObject({
      success: false,
      error: 'Codex 登录正在进行中。',
    })
    first.resolve({ success: true, mode: 'provider' })
    await pending
  })
})

describe('desktop xAI login controls', () => {
  const authInfo: XaiAuthInfo = {
    url: 'https://auth.x.ai/device?user_code=CODE',
    verificationUri: 'https://auth.x.ai/device',
    userCode: 'CODE',
    expiresAt: 123,
  }

  test('passes device codes, saving events and account actions through preload', async () => {
    await import('../electron/preload')
    if (!preloadApi) throw new Error('Preload bridge was not exposed')
    const code = mock((_info: XaiAuthInfo) => {})
    const saving = mock(() => {})
    const unsubscribeCode = preloadApi.onXaiAuth(code)
    const unsubscribeSaving = preloadApi.onXaiLoginSaving(saving)
    for (const listener of rendererListeners.get('auth:xai-code')!) {
      listener(undefined, authInfo)
    }
    for (const listener of rendererListeners.get('auth:xai-saving')!) {
      listener(undefined, undefined)
    }
    expect(code).toHaveBeenCalledWith(authInfo)
    expect(saving).toHaveBeenCalledTimes(1)
    unsubscribeCode()
    unsubscribeSaving()
    expect(rendererListeners.size).toBe(0)
    await preloadApi.getXaiAccounts()
    await preloadApi.switchXaiAccount('work')
    await preloadApi.removeXaiAccount('personal')
    await preloadApi.startXaiLogin({ alias: 'Work' })
    await preloadApi.cancelXaiLogin()
    expect(rendererInvoke.mock.calls).toEqual([
      ['auth:get-xai-accounts'],
      ['auth:switch-xai-account', 'work'],
      ['auth:remove-xai-account', 'personal'],
      ['auth:start-xai-login', { alias: 'Work' }],
      ['auth:cancel-xai-login'],
    ])
  })

  test('publishes codes, rejects duplicate login and cancels when the window closes', async () => {
    const notifications = mock((_channel: string, _payload?: unknown) => {})
    let closed: (() => void) | undefined
    registerIpcHandlers({
      once: (_event: string, callback: () => void) => {
        closed = callback
      },
      isDestroyed: () => false,
      webContents: { send: notifications },
    } as unknown as BrowserWindow)
    const started = Promise.withResolvers<AbortSignal>()
    spyOn(providerAuth, 'loginXaiForDesktop').mockImplementation((options) => {
      options.onAuth?.(authInfo)
      started.resolve(options.signal)
      return new Promise((_resolve, reject) => {
        options.signal!.addEventListener(
          'abort',
          () => reject(options.signal!.reason as Error),
          { once: true },
        )
      })
    })
    const login = invoke('auth:start-xai-login', { alias: 'Work' })
    const signal = await started.promise
    expect(notifications).toHaveBeenCalledWith('auth:xai-code', authInfo)
    expect(openExternal).not.toHaveBeenCalled()
    expect(await invoke('auth:start-xai-login')).toMatchObject({
      success: false,
      error: 'xAI sign-in is already in progress.',
    })
    closed!()
    expect(signal.aborted).toBe(true)
    expect(await login).toMatchObject({ cancelled: true })
    expect(await invoke('auth:cancel-xai-login')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('publishes saving and keeps persistence uncancellable', async () => {
    const notifications = mock((_channel: string, _payload?: unknown) => {})
    registerIpcHandlers({
      once: () => {},
      isDestroyed: () => false,
      webContents: { send: notifications },
    } as unknown as BrowserWindow)
    const saving = Promise.withResolvers<void>()
    const persisted =
      Promise.withResolvers<
        Awaited<ReturnType<typeof providerAuth.loginXaiForDesktop>>
      >()
    spyOn(providerAuth, 'loginXaiForDesktop').mockImplementation((options) => {
      options.onSaving?.()
      saving.resolve()
      return persisted.promise
    })
    const login = invoke('auth:start-xai-login')
    await saving.promise
    expect(notifications).toHaveBeenCalledWith('auth:xai-saving')
    expect(await invoke('auth:cancel-xai-login')).toBe(false)
    persisted.resolve({ success: true, mode: 'provider', providers: ['xai'] })
    expect(await login).toMatchObject({ success: true, providers: ['xai'] })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test.each([
    [
      'authorization_expired',
      'xAI authorization expired. Please sign in again.',
    ],
    [
      'authorization_denied',
      'xAI authorization was denied. Please sign in again.',
    ],
  ] as const)('reports %s in the selected locale', async (reason, error) => {
    spyOn(providerAuth, 'loginXaiForDesktop').mockRejectedValueOnce(
      new XaiOAuthError(reason),
    )
    expect(await invoke('auth:start-xai-login')).toMatchObject({
      success: false,
      error,
    })
    settings.language = 'zh'
    spyOn(providerAuth, 'loginXaiForDesktop').mockRejectedValueOnce(
      new XaiOAuthError(reason),
    )
    const result = await invoke('auth:start-xai-login')
    expect(result).toMatchObject({ success: false })
    expect(result).not.toMatchObject({ error })
  })

  test('returns account summaries and mutation failures without refreshing', async () => {
    const accounts = [{ accountId: 'account-id', alias: 'Work', active: true }]
    spyOn(xaiToken, 'getXaiAccounts').mockResolvedValueOnce(accounts)
    expect(await invoke('auth:get-xai-accounts')).toEqual(accounts)
    spyOn(xaiToken, 'selectXaiAccount').mockRejectedValueOnce(
      new Error('Unknown account'),
    )
    expect(await invoke('auth:switch-xai-account', 'unknown')).toMatchObject({
      success: false,
      error: 'Unknown account',
    })
    spyOn(xaiToken, 'removeXaiAccount').mockRejectedValueOnce(
      new Error('Active account'),
    )
    expect(await invoke('auth:remove-xai-account', 'account-id')).toMatchObject(
      { success: false, error: 'Active account' },
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('desktop saves automatically refresh the running gateway', () => {
  test('remembers the startup key before the first save after an external rotation', async () => {
    await invoke('server:start', 4141, 'provider')
    keys.adminApiKey = 'external-admin'
    await invoke('config:save-provider-management', {})
    expect(activeAdminApiKey).toBe('external-admin')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4141/admin/config/reload',
      expect.objectContaining({ headers: { 'x-api-key': 'old-admin' } }),
    )
  })

  test('remembers the restarted key before another external rotation', async () => {
    await invoke('server:start', 4141, 'provider')
    await invoke('server:stop')
    keys.adminApiKey = 'restarted-admin'
    await invoke('server:start', 4141, 'provider')
    keys.adminApiKey = 'external-admin'
    await invoke('config:save-provider-management', {})
    expect(activeAdminApiKey).toBe('external-admin')
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4141/admin/config/reload',
      expect.objectContaining({ headers: { 'x-api-key': 'restarted-admin' } }),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('keeps the automatically restarted key when its follow-up refresh fails', async () => {
    await invoke('server:start', 4141, 'provider')
    keys.adminApiKey = 'restarted-admin'
    spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('connection failed'),
    )
    await expect(
      invoke('settings:save', { ...settings, host: '0.0.0.0' }),
    ).rejects.toThrow('refresh failed: connection failed')
    expect(activeAdminApiKey).toBe('restarted-admin')
    keys.adminApiKey = 'external-admin'
    await invoke('config:save-provider-management', {})
    expect(activeAdminApiKey).toBe('external-admin')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('keeps the previous running key when starting another server fails', async () => {
    await invoke('server:start', 4141, 'provider')
    keys.adminApiKey = 'external-admin'
    restartError = 'address unavailable'
    expect(await invoke('server:start', 4142, 'provider')).toEqual({
      running: false,
      error: 'address unavailable',
    })
    await invoke('config:save-provider-management', {})
    expect(activeAdminApiKey).toBe('external-admin')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  const updates: Array<[string, unknown]> = [
    ['config:save-provider-management', {}],
    ['auth:configure-provider', {}],
    ['auth:switch-codex-account', 'account-id'],
    ['auth:remove-codex-account', 'account-id'],
    ['auth:start-codex-login', {}],
    ['auth:switch-xai-account', 'account-id'],
    ['auth:remove-xai-account', 'account-id'],
    ['auth:start-xai-login', {}],
    ['auth:save-token', 'github-token'],
    ['auth:logout', undefined],
  ]
  test.each(updates)('refreshes after %s', async (channel, input) => {
    await invoke(channel, input)
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4141/admin/config/reload',
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-api-key': 'old-admin' },
      }),
    )
  })

  test('completes GitHub sign-in when the running service cannot refresh', async () => {
    spyOn(auth, 'getCopilotAccountType').mockResolvedValue('business')
    spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('connection failed'),
    )
    expect(await invoke('auth:save-token', 'github-token')).toEqual({
      success: true,
      mode: 'copilot',
    })
    // The account type is written after the token, so it is only persisted
    // when a failed refresh no longer aborts the sign-in flow.
    expect(settings.accountType).toBe('business')
    expect(activeAdminApiKey).toBe('old-admin')
  })

  test('does not save a cancelled device token waiting behind another credential update', async () => {
    const login =
      Promise.withResolvers<
        Awaited<ReturnType<typeof providerAuth.loginCodexForDesktop>>
      >()
    const loginStarted = Promise.withResolvers<void>()
    const settingsRead = Promise.withResolvers<void>()
    const nextToken = Promise.withResolvers<string>()
    const notifications: string[] = []
    spyOn(providerAuth, 'loginCodexForDesktop').mockImplementation(() => {
      loginStarted.resolve()
      return login.promise
    })
    spyOn(settingsStore, 'readSettings').mockImplementation(() => {
      settingsRead.resolve()
      return Promise.resolve(structuredClone(settings))
    })
    spyOn(auth, 'getDeviceCode').mockResolvedValue({
      device_code: 'device-code',
      user_code: 'CODE',
      verification_uri: 'https://github.com/login/device',
      interval: 5,
      expires_in: 900,
    })
    let polls = 0
    spyOn(auth, 'pollAccessToken').mockImplementation(() =>
      ++polls === 1 ? Promise.resolve('cancelled-token') : nextToken.promise,
    )
    registerIpcHandlers({
      once: () => {},
      isDestroyed: () => false,
      webContents: { send: (channel: string) => notifications.push(channel) },
    } as unknown as BrowserWindow)
    const pendingLogin = invoke('auth:start-codex-login', {})
    await loginStarted.promise
    await invoke('auth:get-device-code')
    await settingsRead.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(auth.saveToken).not.toHaveBeenCalled()
    await invoke('auth:get-device-code')
    login.resolve({ success: true, mode: 'provider', providers: ['codex'] })
    await pendingLogin
    await invoke('config:save-provider-management', {})
    expect(auth.saveToken).not.toHaveBeenCalled()
    expect(settingsStore.writeSettings).not.toHaveBeenCalled()
    expect(notifications).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)

    nextToken.resolve('current-token')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await invoke('config:save-provider-management', {})
    expect(auth.saveToken).toHaveBeenCalledTimes(1)
    expect(auth.saveToken).toHaveBeenCalledWith('current-token')
    expect(notifications).toEqual(['auth:success'])
  })

  test('rotates keys using the active old admin key', async () => {
    const saved = await invoke('auth:save-server-keys', {
      apiKeys: ['new-api'],
      adminApiKey: 'new-admin',
    })
    expect(saved).toEqual({ apiKeys: ['new-api'], adminApiKey: 'new-admin' })
    expect(activeAdminApiKey).toBe('new-admin')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('returns a regenerated admin key after the user clears it', async () => {
    const saved = await invoke('auth:save-server-keys', { adminApiKey: '' })
    expect(saved).toEqual({
      apiKeys: ['old-api'],
      adminApiKey: 'regenerated-admin',
    })
    expect(activeAdminApiKey).toBe('regenerated-admin')
  })

  test('recovers after a saved key rotation could not refresh the service', async () => {
    spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('connection failed'),
    )
    await expect(
      invoke('auth:save-server-keys', { adminApiKey: 'new-admin' }),
    ).rejects.toThrow(
      'Configuration saved, but refresh failed: connection failed',
    )
    expect(keys.adminApiKey).toBe('new-admin')
    expect(activeAdminApiKey).toBe('old-admin')
    await invoke('auth:save-server-keys', { adminApiKey: 'new-admin' })
    expect(activeAdminApiKey).toBe('new-admin')
  })

  test('retries a saved key when the server has already loaded it', async () => {
    await invoke('config:save-provider-management', {})
    keys.adminApiKey = 'restarted-admin'
    activeAdminApiKey = keys.adminApiKey
    await invoke('config:save-provider-management', {})
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('only saves while the service is stopped', async () => {
    running = false
    await invoke('auth:save-server-keys', { adminApiKey: 'new-admin' })
    expect(keys.adminApiKey).toBe('new-admin')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('restarts automatically when a server startup setting changes', async () => {
    await invoke('settings:save', { ...settings, host: '0.0.0.0' })
    expect(startServer).toHaveBeenCalledWith(
      4141,
      expect.objectContaining({ host: '0.0.0.0' }),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('keeps the running service for desktop-only settings', async () => {
    await invoke('settings:save', { ...settings, theme: 'dark' })
    expect(startServer).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('does not start a stopped service after saving startup settings', async () => {
    running = false
    await invoke('settings:save', { ...settings, host: '0.0.0.0' })
    expect(startServer).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('reports a failed automatic restart', async () => {
    restartError = 'address unavailable'
    await expect(
      invoke('settings:save', { ...settings, host: '0.0.0.0' }),
    ).rejects.toThrow('address unavailable')
  })
})

describe('desktop token usage sessions', () => {
  function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.toString()
    return input.url
  }

  test('requests five sessions per page and normalizes invalid paging', async () => {
    const payload = {
      items: [],
      page: 1,
      page_size: 5,
      total: 0,
      total_pages: 1,
    }
    const fetchSessions = Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        if (
          fetchInputUrl(input)
          === 'http://127.0.0.1:4141/token-usage/sessions?page=1&page_size=5&period=this_week'
        ) {
          return Promise.resolve(Response.json(payload))
        }
        return Promise.resolve(new Response(null, { status: 500 }))
      },
      { preconnect: () => {} },
    )
    spyOn(globalThis, 'fetch').mockImplementation(fetchSessions)
    await expect(
      invoke('server:fetch-token-usage-sessions', 'this_week', 0, Number.NaN),
    ).resolves.toEqual(payload)
  })

  test('returns null when session usage cannot be loaded', async () => {
    const fetchSessions = Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        expect(fetchInputUrl(input)).toBe(
          'http://127.0.0.1:4141/token-usage/sessions?page=2&page_size=5&period=today',
        )
        return Promise.resolve(new Response(null, { status: 500 }))
      },
      { preconnect: () => {} },
    )
    spyOn(globalThis, 'fetch').mockImplementation(fetchSessions)
    await expect(
      invoke('server:fetch-token-usage-sessions', 'nope', 2, 5),
    ).resolves.toBeNull()

    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    await expect(
      invoke('server:fetch-token-usage-sessions', 'today', 2, 5),
    ).resolves.toBeNull()
  })

  test('exposes session usage through the preload bridge', async () => {
    await import('../electron/preload')
    if (!preloadApi) throw new Error('Preload bridge was not exposed')
    await preloadApi.fetchTokenUsageSessions('today', 2, 5)
    expect(rendererInvoke).toHaveBeenCalledWith(
      'server:fetch-token-usage-sessions',
      'today',
      2,
      5,
    )
  })
})

describe('desktop configuration editor bridge', () => {
  test('returns structured conflict, validation and read errors from the main process', async () => {
    const originalPath = PATHS.CONFIG_PATH
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'desktop-config-errors-'),
    )
    PATHS.CONFIG_PATH = path.join(directory, 'config.json')
    try {
      running = false
      const document = (await invoke(
        'config:get-document',
      )) as AppConfigDocument
      fs.writeFileSync(PATHS.CONFIG_PATH, '{}')
      expect(
        await invoke('config:save-document', {
          revision: document.revision,
          content: '{}',
        }),
      ).toEqual({ error: { code: 'conflict' } })
      const current = (await invoke('config:get-document')) as AppConfigDocument
      expect(
        await invoke('config:save-document', {
          revision: current.revision,
          content: '[]',
        }),
      ).toEqual({
        error: { code: 'validation', message: 'Config must be a JSON object.' },
      })
      fs.rmSync(PATHS.CONFIG_PATH)
      fs.mkdirSync(PATHS.CONFIG_PATH)
      expect(await invoke('config:get-document')).toEqual({
        error: { code: 'readFailed' },
      })
    } finally {
      PATHS.CONFIG_PATH = originalPath
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('passes error codes through the preload as plain data', async () => {
    await import('../electron/preload')
    if (!preloadApi) throw new Error('Preload bridge was not exposed')
    const failure = { error: { code: 'conflict' as const } }
    rendererInvoke.mockResolvedValueOnce(failure)
    expect(
      await preloadApi.saveAppConfig({ revision: 'old', content: '{}' }),
    ).toEqual(failure)
  })
  test('reads, saves offline, and applies the document through main-process handlers', async () => {
    const originalPath = PATHS.CONFIG_PATH
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'desktop-config-ipc-'),
    )
    PATHS.CONFIG_PATH = path.join(directory, 'config.json')
    try {
      running = false
      const document = (await invoke(
        'config:get-document',
      )) as AppConfigDocument
      const saved = (await invoke('config:save-document', {
        revision: document.revision,
        content: JSON.stringify({
          auth: { adminApiKey: 'old-admin' },
          useMessagesApi: false,
        }),
      })) as AppConfigSaveResult
      expect(saved.saved).toBe(true)
      expect(saved.applied).toBe(false)
      expect(saved.configPath).toBe(PATHS.CONFIG_PATH)
      running = true
      const applied = (await invoke(
        'config:apply-document',
        saved.revision,
      )) as AppConfigSaveResult
      expect(applied.applied).toBe(true)
      expect(JSON.parse(applied.content)).toEqual({
        auth: { adminApiKey: 'old-admin' },
        useMessagesApi: false,
      })
    } finally {
      PATHS.CONFIG_PATH = originalPath
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  test('exposes document read, save and apply through the typed preload bridge', async () => {
    await import('../electron/preload')
    if (!preloadApi) throw new Error('Preload bridge was not exposed')
    const update = { revision: 'revision', content: '{}' }
    await preloadApi.getAppConfig()
    await preloadApi.saveAppConfig(update)
    await preloadApi.applyAppConfig('revision')
    expect(rendererInvoke).toHaveBeenCalledWith('config:get-document')
    expect(rendererInvoke).toHaveBeenCalledWith('config:save-document', update)
    expect(rendererInvoke).toHaveBeenCalledWith(
      'config:apply-document',
      'revision',
    )
    expect(handlers.has('config:get-document')).toBe(true)
    expect(handlers.has('config:save-document')).toBe(true)
    expect(handlers.has('config:apply-document')).toBe(true)
  })
})
