import { describe, expect, mock, test } from 'bun:test'

import {
  configureDesktopProvider,
  configureProviderWithAuthStatus,
  getDesktopCodexAccounts,
  getDesktopAuthStatus,
  loginCodexForDesktop,
  loginXaiForDesktop,
  removeCodexAccountForDesktop,
  selectCodexAccountForDesktop,
  shouldStartInProviderMode,
} from '../electron/provider-auth'
import type { ProviderConfig } from '../../src/lib/config'

describe('desktop provider auth', () => {
  test.each(['__default__', 'x-goog-api-key'] as const)(
    'configures Google with %s auth',
    (authType) => {
      let written: ProviderConfig | undefined
      configureDesktopProvider(
        {
          provider: 'custom',
          name: 'google',
          type: 'google',
          apiKey: 'google-key',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          authType,
        },
        {
          getEnabledProviders: () => ['google'],
          getRawProviderConfig: () => null,
          setProviderConfig(_name, config) {
            written = config
            return config
          },
        },
      )
      expect(written).toEqual({
        type: 'google',
        apiKey: 'google-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        enabled: true,
        ...(authType !== '__default__' && { authType }),
      })
    },
  )
  test.each([{ agentsModels: [] }, { agentsModels: ['deepseek-v4-pro'] }])(
    'preserves quick provider Codex selection %j during reauthorization',
    ({ agentsModels }) => {
      let written: ProviderConfig | undefined
      configureDesktopProvider(
        { provider: 'deepseek', apiKey: 'new-key' },
        {
          getEnabledProviders: () => ['deepseek'],
          getRawProviderConfig: () => ({ agentsModels: [...agentsModels] }),
          setProviderConfig(_name, provider) {
            written = provider
            return provider
          },
        },
      )
      expect(written?.agentsModels).toEqual([...agentsModels])
      expect(written?.apiKey).toBe('new-key')
    },
  )
  test('configures deepseek from the quick provider template with defaults', () => {
    let writtenProviderName = ''
    let writtenProviderConfig: ProviderConfig | undefined

    const result = configureDesktopProvider(
      {
        apiKey: 'deepseek-key',
        provider: 'deepseek',
      },
      {
        getEnabledProviders: () => ['deepseek'],
        getRawProviderConfig: () => null,
        setProviderConfig(name, provider) {
          writtenProviderName = name
          writtenProviderConfig = provider
          return provider
        },
      },
    )

    expect(result).toEqual({
      mode: 'provider',
      providers: ['deepseek'],
      success: true,
    })
    expect(writtenProviderName).toBe('deepseek')
    expect(writtenProviderConfig).toEqual({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com/anthropic',
      enabled: true,
      pricingCurrency: 'CNY',
      type: 'anthropic',
    })
  })

  test('configures a custom provider with normalized fields and preserved model settings', () => {
    let writtenProviderName = ''
    let writtenProviderConfig: ProviderConfig | undefined

    const result = configureDesktopProvider(
      {
        apiKey: ' custom-key ',
        authType: '__default__',
        baseUrl: 'https://custom.example/api///',
        name: 'custom_deepseek',
        provider: 'custom',
        type: 'anthropic',
      },
      {
        getEnabledProviders: () => ['custom_deepseek'],
        getRawProviderConfig: () => ({
          agentsModels: ['deepseek-v4-pro'],
          models: {
            'deepseek-v4-pro': {
              temperature: 0.2,
            },
          },
          pricingCurrency: 'CNY',
        }),
        setProviderConfig(name, provider) {
          writtenProviderName = name
          writtenProviderConfig = provider
          return provider
        },
      },
    )

    expect(result).toEqual({
      mode: 'provider',
      providers: ['custom_deepseek'],
      success: true,
    })
    expect(writtenProviderName).toBe('custom_deepseek')
    expect(writtenProviderConfig).toEqual({
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example/api',
      agentsModels: ['deepseek-v4-pro'],
      enabled: true,
      models: {
        'deepseek-v4-pro': {
          temperature: 0.2,
        },
      },
      pricingCurrency: 'CNY',
      type: 'anthropic',
    })
  })

  test('stores the selected models.dev provider ID with its API URL', () => {
    let writtenProviderConfig: ProviderConfig | undefined
    configureDesktopProvider(
      {
        apiKey: ' catalog-key ',
        baseUrl: 'https://api.example.com/openai/v1/',
        modelsDevProviderId: 'catalog-provider',
        name: 'catalog-provider',
        provider: 'custom',
        type: 'openai-responses',
      },
      {
        getEnabledProviders: () => ['catalog-provider'],
        getRawProviderConfig: () => null,
        setProviderConfig(_name, provider) {
          writtenProviderConfig = provider
          return provider
        },
      },
    )

    expect(writtenProviderConfig).toEqual({
      apiKey: 'catalog-key',
      baseUrl: 'https://api.example.com/openai/v1',
      enabled: true,
      modelsDevProviderId: 'catalog-provider',
      pricingCurrency: undefined,
      type: 'openai-responses',
    })
  })

  test('configures openrouter with a fixed anthropic provider type', () => {
    let writtenProviderConfig: ProviderConfig | undefined

    configureDesktopProvider(
      {
        apiKey: 'openrouter-key',
        baseUrl: 'https://openrouter.example/api///',
        provider: 'openrouter',
        type: 'openai-compatible',
      },
      {
        getEnabledProviders: () => ['openrouter'],
        getRawProviderConfig: () => null,
        setProviderConfig(_name, provider) {
          writtenProviderConfig = provider
          return provider
        },
      },
    )

    expect(writtenProviderConfig).toEqual({
      apiKey: 'openrouter-key',
      baseUrl: 'https://openrouter.example/api',
      enabled: true,
      pricingCurrency: 'USD',
      type: 'anthropic',
    })
  })

  test('configures opencode-go with a fixed openai-compatible provider type', () => {
    let writtenProviderConfig: ProviderConfig | undefined

    configureDesktopProvider(
      {
        apiKey: 'opencode-key',
        baseUrl: 'https://opencode.example/zen/go///',
        provider: 'opencode-go',
        type: 'anthropic',
      },
      {
        getEnabledProviders: () => ['opencode-go'],
        getRawProviderConfig: () => null,
        setProviderConfig(_name, provider) {
          writtenProviderConfig = provider
          return provider
        },
      },
    )

    expect(writtenProviderConfig).toEqual({
      apiKey: 'opencode-key',
      baseUrl: 'https://opencode.example/zen/go',
      enabled: true,
      pricingCurrency: 'USD',
      type: 'openai-compatible',
    })
  })

  test('configures kimi with an editable provider type', () => {
    let writtenProviderConfig: ProviderConfig | undefined

    configureDesktopProvider(
      {
        apiKey: 'kimi-key',
        baseUrl: 'https://kimi.example/coding///',
        provider: 'kimi',
        type: 'openai-compatible',
      },
      {
        getEnabledProviders: () => ['kimi'],
        getRawProviderConfig: () => null,
        setProviderConfig(_name, provider) {
          writtenProviderConfig = provider
          return provider
        },
      },
    )

    expect(writtenProviderConfig).toEqual({
      apiKey: 'kimi-key',
      baseUrl: 'https://kimi.example/coding',
      enabled: true,
      pricingCurrency: 'USD',
      type: 'openai-compatible',
    })
  })

  test('rejects invalid provider input before writing config', () => {
    let writes = 0
    const dependencies = {
      getEnabledProviders: () => [],
      getRawProviderConfig: () => null,
      setProviderConfig() {
        writes += 1
        return {}
      },
    }

    expect(() =>
      configureDesktopProvider(
        {
          apiKey: 'key',
          authType: '__default__',
          baseUrl: 'https://example.com',
          name: 'copilot',
          provider: 'custom',
          type: 'anthropic',
        },
        dependencies,
      ),
    ).toThrow("Provider name 'copilot' is reserved for a builtin provider")

    expect(() =>
      configureDesktopProvider(
        {
          apiKey: 'key',
          authType: 'oauth2',
          baseUrl: 'https://example.com',
          name: 'custom',
          provider: 'custom',
          type: 'anthropic',
        } as never,
        dependencies,
      ),
    ).toThrow('No provider auth type selected')

    expect(() =>
      configureDesktopProvider(
        {
          apiKey: 'key',
          authType: '__default__',
          baseUrl: '   ',
          name: 'custom',
          provider: 'custom',
          type: 'anthropic',
        },
        dependencies,
      ),
    ).toThrow('baseUrl must be a non-empty string')

    expect(() =>
      configureDesktopProvider(
        {
          apiKey: '   ',
          baseUrl: 'https://example.com',
          provider: 'deepseek',
          type: 'anthropic',
        },
        dependencies,
      ),
    ).toThrow('apiKey must be a non-empty string')

    expect(() =>
      configureDesktopProvider(
        {
          apiKey: 'key',
          baseUrl: 'https://example.com',
          provider: 'deepseek',
          type: 'unsupported',
        } as never,
        dependencies,
      ),
    ).toThrow('No provider type selected')

    expect(writes).toBe(0)
  })

  test('skips GitHub verification when builtin Copilot is disabled and falls back to other enabled providers', async () => {
    let verifications = 0
    const dependencies = {
      isGitHubCopilotEnabled: () => false,
      readToken: () => Promise.resolve('saved-token'),
      verifyGitHubToken: () => {
        verifications++
        return Promise.resolve()
      },
    }
    expect(
      await getDesktopAuthStatus({
        ...dependencies,
        listEnabledProviders: () => ['deepseek'],
      }),
    ).toEqual({ success: true, mode: 'provider', providers: ['deepseek'] })
    expect(
      await getDesktopAuthStatus({
        ...dependencies,
        listEnabledProviders: () => [],
      }),
    ).toEqual({ success: false, mode: 'none', providers: [] })
    expect(verifications).toBe(0)
  })
  test('reports desktop auth status from token and provider dependencies', () => {
    expect(
      getDesktopAuthStatus({
        listEnabledProviders: () => [],
        readToken: () => Promise.resolve(null),
      }),
    ).resolves.toEqual({
      mode: 'none',
      providers: [],
      success: false,
    })

    expect(
      getDesktopAuthStatus({
        listEnabledProviders: () => ['deepseek'],
        readToken: () => Promise.resolve('stale-token'),
        verifyGitHubToken: () => Promise.reject(new Error('stale')),
      }),
    ).resolves.toEqual({
      mode: 'provider',
      providers: ['deepseek'],
      success: true,
    })

    expect(
      getDesktopAuthStatus({
        listEnabledProviders: () => [],
        readToken: () => Promise.resolve('valid-token'),
        verifyGitHubToken: (token) => {
          expect(token).toBe('valid-token')
          return Promise.resolve()
        },
      }),
    ).resolves.toEqual({
      mode: 'copilot',
      success: true,
    })
  })

  test('logs in to codex through injected desktop OAuth dependencies', async () => {
    let openedUrl = ''
    let promptValue = ''
    let persistedAccessToken = ''
    let enableProvider: boolean | undefined
    let activateAccount: boolean | undefined
    let persistedAlias: string | undefined
    let savingAnnounced = false

    const result = await loginCodexForDesktop(
      {
        alias: ' Work ',
        callbackUrlOrCode: ' callback-code ',
        onAuthUrl: (url) => {
          openedUrl = url
        },
        onSaving: () => {
          savingAnnounced = true
        },
      },
      {
        getEnabledProviders: () => ['codex'],
        loginCodex: async (options) => {
          options.onAuth({ url: 'https://auth.example' })
          promptValue = await options.onPrompt('Paste code')
          return {
            accessToken: 'codex-access-token',
            accountId: 'acct_test',
            expiresAt: 1_893_456_000_000,
            refreshToken: 'codex-refresh-token',
          }
        },
        persistCodexCredentials: (credentials, options) => {
          expect(savingAnnounced).toBe(true)
          persistedAccessToken = credentials.accessToken
          enableProvider = options?.enableProvider
          activateAccount = options?.activateAccount
          persistedAlias = options?.alias
          return Promise.resolve()
        },
      },
    )

    expect(openedUrl).toBe('https://auth.example')
    expect(promptValue).toBe('callback-code')
    expect(persistedAccessToken).toBe('codex-access-token')
    expect(enableProvider).toBe(true)
    expect(activateAccount).toBe(true)
    expect(persistedAlias).toBe('Work')
    expect(result).toEqual({
      mode: 'provider',
      providers: ['codex'],
      success: true,
    })
  })

  test('does not start an already cancelled Codex login', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Cancelled'))
    const login = mock(() => Promise.reject(new Error('Unexpected login')))
    await expect(
      loginCodexForDesktop(
        { signal: controller.signal },
        { loginCodex: login },
      ),
    ).rejects.toThrow('Cancelled')
    expect(login).not.toHaveBeenCalled()
  })

  test('does not persist credentials when Codex login was cancelled', async () => {
    const controller = new AbortController()
    const persist = mock(() => Promise.resolve())
    const onSaving = mock(() => {})
    await expect(
      loginCodexForDesktop(
        { signal: controller.signal, onSaving },
        {
          loginCodex: (options) => {
            expect(options.signal).toBe(controller.signal)
            controller.abort(new Error('Cancelled'))
            return Promise.resolve({
              accessToken: 'test-access',
              refreshToken: 'test-refresh',
              accountId: 'acct_test',
              expiresAt: 0,
            })
          },
          persistCodexCredentials: persist,
        },
      ),
    ).rejects.toThrow('Cancelled')
    expect(persist).not.toHaveBeenCalled()
    expect(onSaving).not.toHaveBeenCalled()
  })

  test('lists safe Codex account summaries through desktop auth', () => {
    const accounts = [
      { accountId: 'acct_one', alias: 'Work', active: true },
      { accountId: 'acct_two', active: false },
    ]

    expect(
      getDesktopCodexAccounts({
        getCodexAccounts: () => Promise.resolve(accounts),
      }),
    ).resolves.toEqual(accounts)
  })

  test('selects a Codex account without restarting the server', async () => {
    let selectedAccountId = ''

    const result = await selectCodexAccountForDesktop('acct_two', {
      getEnabledProviders: () => ['codex'],
      selectCodexAccount: (accountId) => {
        selectedAccountId = accountId
        return Promise.resolve({ accountId, active: true })
      },
    })

    expect(selectedAccountId).toBe('acct_two')
    expect(result).toEqual({
      mode: 'provider',
      providers: ['codex'],
      success: true,
    })
  })

  test('removes an unused Codex account through desktop auth', async () => {
    let removedAccountId = ''

    const result = await removeCodexAccountForDesktop('acct_two', {
      getEnabledProviders: () => ['codex'],
      removeCodexAccount: (accountId) => {
        removedAccountId = accountId
        return Promise.resolve({ accountId, active: false })
      },
    })

    expect(removedAccountId).toBe('acct_two')
    expect(result).toEqual({
      mode: 'provider',
      providers: ['codex'],
      success: true,
    })
  })

  test('starts in provider mode only for provider auth mode', () => {
    expect(shouldStartInProviderMode('provider')).toBe(true)
    expect(shouldStartInProviderMode('copilot')).toBe(false)
    expect(shouldStartInProviderMode(undefined)).toBe(false)
  })

  test('configureProviderWithAuthStatus keeps copilot mode when a valid token exists', async () => {
    const result = await configureProviderWithAuthStatus(
      { apiKey: 'deepseek-key', provider: 'deepseek' },
      {
        getEnabledProviders: () => ['deepseek'],
        getRawProviderConfig: () => null,
        setProviderConfig: () => ({}),
        listEnabledProviders: () => ['deepseek'],
        readToken: () => Promise.resolve('valid-token'),
        verifyGitHubToken: () => Promise.resolve(),
      },
    )

    expect(result).toEqual({ success: true, mode: 'copilot' })
  })

  test('configureProviderWithAuthStatus falls back to provider mode without a token', async () => {
    const result = await configureProviderWithAuthStatus(
      { apiKey: 'deepseek-key', provider: 'deepseek' },
      {
        getEnabledProviders: () => ['deepseek'],
        getRawProviderConfig: () => null,
        setProviderConfig: () => ({}),
        listEnabledProviders: () => ['deepseek'],
        readToken: () => Promise.resolve(null),
      },
    )

    expect(result).toEqual({
      mode: 'provider',
      providers: ['deepseek'],
      success: true,
    })
  })

  test('configureProviderWithAuthStatus drops to provider mode when the token is stale', async () => {
    const result = await configureProviderWithAuthStatus(
      { apiKey: 'deepseek-key', provider: 'deepseek' },
      {
        getEnabledProviders: () => ['deepseek'],
        getRawProviderConfig: () => null,
        setProviderConfig: () => ({}),
        listEnabledProviders: () => ['deepseek'],
        readToken: () => Promise.resolve('stale-token'),
        verifyGitHubToken: () => Promise.reject(new Error('stale')),
      },
    )

    expect(result).toEqual({
      mode: 'provider',
      providers: ['deepseek'],
      success: true,
    })
  })

  test('configureProviderWithAuthStatus rethrows configuration validation errors', async () => {
    const error = await configureProviderWithAuthStatus(
      {
        apiKey: '   ',
        baseUrl: 'https://example.com',
        provider: 'deepseek',
        type: 'anthropic',
      },
      {
        getEnabledProviders: () => [],
        getRawProviderConfig: () => null,
        setProviderConfig: () => ({}),
        listEnabledProviders: () => [],
        readToken: () => Promise.resolve(null),
      },
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('apiKey must be a non-empty string')
  })
})

describe('desktop xAI login', () => {
  test('saves credentials with an alias and returns provider mode', async () => {
    const credentials = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 100,
      accountId: 'xai-user',
    }
    const onAuth = mock(() => {})
    const onSaving = mock(() => {})
    const persist = mock(() => Promise.resolve())
    const result = await loginXaiForDesktop(
      { alias: ' Work ', onAuth, onSaving },
      {
        loginXai: (options) => {
          options.onAuth({
            url: 'https://auth.x.ai/device',
            userCode: 'CODE',
            verificationUri: 'https://auth.x.ai/device',
            expiresAt: 100,
          })
          return Promise.resolve(credentials)
        },
        persistXaiCredentials: persist,
        getEnabledProviders: () => ['xai'],
      },
    )
    expect(result).toEqual({
      success: true,
      mode: 'provider',
      providers: ['xai'],
    })
    expect(persist).toHaveBeenCalledWith(credentials, { alias: 'Work' })
    expect(onAuth).toHaveBeenCalled()
    expect(onSaving).toHaveBeenCalled()
  })
  test('does not save credentials after cancellation', async () => {
    const controller = new AbortController()
    const persist = mock(() => Promise.resolve())
    const reason = new Error('cancelled')
    const result: unknown = await loginXaiForDesktop(
      { signal: controller.signal },
      {
        loginXai: () => {
          controller.abort(reason)
          return Promise.resolve({
            accessToken: 'a',
            refreshToken: 'r',
            expiresAt: 100,
            accountId: 'xai-user',
          })
        },
        persistXaiCredentials: persist,
      },
    ).catch((error: unknown) => error)
    expect(result).toBe(reason)
    expect(persist).not.toHaveBeenCalled()
  })
})
