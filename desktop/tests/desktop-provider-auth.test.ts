import { describe, expect, test } from 'bun:test'

import {
  configureDesktopProvider,
  configureProviderWithAuthStatus,
  getDesktopAuthStatus,
  loginCodexForDesktop,
  shouldStartInProviderMode,
} from '../electron/provider-auth'
import type { ProviderConfig } from '../../src/lib/config'

describe('desktop provider auth', () => {
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
          imageEndpoints: ['generations', 'edits'],
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
      enabled: true,
      imageEndpoints: ['generations', 'edits'],
      models: {
        'deepseek-v4-pro': {
          temperature: 0.2,
        },
      },
      pricingCurrency: 'CNY',
      type: 'anthropic',
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

  test('reports desktop auth status from token and provider dependencies', async () => {
    await expect(
      getDesktopAuthStatus({
        listEnabledProviders: () => [],
        readToken: async () => null,
      }),
    ).resolves.toEqual({
      mode: 'none',
      providers: [],
      success: false,
    })

    await expect(
      getDesktopAuthStatus({
        listEnabledProviders: () => ['deepseek'],
        readToken: async () => 'stale-token',
        verifyGitHubToken: async () => {
          throw new Error('stale')
        },
      }),
    ).resolves.toEqual({
      mode: 'provider',
      providers: ['deepseek'],
      success: true,
    })

    await expect(
      getDesktopAuthStatus({
        listEnabledProviders: () => [],
        readToken: async () => 'valid-token',
        verifyGitHubToken: async (token) => {
          expect(token).toBe('valid-token')
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

    const result = await loginCodexForDesktop(
      {
        callbackUrlOrCode: ' callback-code ',
        openUrl: (url) => {
          openedUrl = url
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
        persistCodexCredentials: async (credentials, options) => {
          persistedAccessToken = credentials.accessToken
          enableProvider = options?.enableProvider
        },
      },
    )

    expect(openedUrl).toBe('https://auth.example')
    expect(promptValue).toBe('callback-code')
    expect(persistedAccessToken).toBe('codex-access-token')
    expect(enableProvider).toBe(true)
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
        readToken: async () => 'valid-token',
        verifyGitHubToken: async () => {},
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
        readToken: async () => null,
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
        readToken: async () => 'stale-token',
        verifyGitHubToken: async () => {
          throw new Error('stale')
        },
      },
    )

    expect(result).toEqual({
      mode: 'provider',
      providers: ['deepseek'],
      success: true,
    })
  })

  test('configureProviderWithAuthStatus rethrows configuration validation errors', async () => {
    await expect(
      configureProviderWithAuthStatus(
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
          readToken: async () => null,
        },
      ),
    ).rejects.toThrow('apiKey must be a non-empty string')
  })
})
