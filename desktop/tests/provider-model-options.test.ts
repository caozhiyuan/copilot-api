import { describe, expect, test } from 'bun:test'
import { installModelsDevCatalog } from '../../src/lib/models-dev-cache'
import {
  modelsDevReleaseModelsFixture,
  modelsDevProviderCatalogFixture,
} from '../../tests/fixtures/models-dev-catalog'
import { buildProviderModelOptions } from '../electron/provider-model-options'
import {
  mergeProviderModelOptions,
  parseModelSelection,
} from '../src/lib/provider-model-options'

describe('provider model options', () => {
  test('filters old releases from all cached, configured and selected models.dev options', () => {
    const catalog = { models: modelsDevReleaseModelsFixture }
    installModelsDevCatalog({
      ...modelsDevProviderCatalogFixture,
      'alibaba-cn': catalog,
      xai: catalog,
      'opencode-go': catalog,
    })
    const selection = {
      models: { 'before-cutoff': {}, 'qwen-plus': {} },
      agentsModels: Object.keys(modelsDevReleaseModelsFixture),
    }
    const options = buildProviderModelOptions({
      providers: {
        dashscope: selection,
        xai: selection,
        'opencode-go': selection,
        custom: { ...selection, modelsDevProviderId: 'alibaba-cn' },
      },
    })
    for (const name of ['dashscope', 'xai', 'opencode-go', 'custom']) {
      expect(options[name]).toEqual([
        'after-cutoff',
        'invalid-date',
        'on-cutoff',
        'unknown-date',
      ])
    }
  })

  test('reads default catalogs and provider aliases without static model fallback', () => {
    installModelsDevCatalog(modelsDevProviderCatalogFixture)
    const options = buildProviderModelOptions({
      providers: {
        xai: {},
        deepseek: {},
        kimi: {},
        dashscope: {},
        custom: { modelsDevProviderId: 'openrouter' },
      },
    })
    expect(options).toMatchObject({
      xai: ['grok-4.7', 'grok-catalog-only'],
      deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
      kimi: ['k3', 'k3-256k'],
      dashscope: [
        'deepseek-v4.1-flash',
        'glm-5.3',
        'kimi-k3',
        'qwen3.7-plus',
        'qwen3.8-flash',
        'qwen3.8-max',
      ],
      custom: ['openai/gpt-5.1-codex'],
    })
    expect(options.dashscope).not.toContain('ZHIPU/GLM-5.3-FlashX')
  })
  test('combines cached xAI models with explicit selections for OAuth providers', () => {
    const options = buildProviderModelOptions(
      {
        providers: {
          xai: {
            authType: 'oauth2',
            enabled: false,
            models: { 'unsupported-model': {} },
            agentsModels: ['unsupported-model'],
          },
        },
      },
      {
        builtin: (name) => (name === 'xai' ? ['grok-4.7'] : []),
        catalog: () => ['unwanted-catalog-model'],
      },
    )
    expect(options.xai).toEqual([
      'grok-4.7',
      'unsupported-model',
      'unwanted-catalog-model',
    ])
  })
  test('combines configured, selected, builtin and catalog models for disabled providers without credentials', () => {
    const options = buildProviderModelOptions(
      {
        providers: {
          example: {
            enabled: false,
            apiKey: 'secret-key',
            modelsDevProviderId: 'catalog',
            models: { configured: {} },
            agentsModels: ['selected', 'configured'],
          },
          copilot: { apiKey: 'another-secret' },
        },
      },
      {
        builtin: () => ['builtin', 'configured'],
        catalog: (name) =>
          name === 'catalog' ? ['catalog-model', 'configured'] : [],
      },
    )
    expect(options).toEqual({
      'github-copilot': ['builtin', 'configured'],
      example: ['builtin', 'catalog-model', 'configured', 'selected'],
    })
    expect(JSON.stringify(options)).not.toContain('secret')
  })
  test('merges builtin Copilot model IDs including namespaced upstream IDs without stealing configured provider aliases', () => {
    expect(
      mergeProviderModelOptions(
        { 'github-copilot': [], custom: [] },
        {
          data: [
            { id: 'gpt-5.4' },
            { id: 'org/family/model' },
            { id: 'custom/model' },
          ],
        },
      ),
    ).toEqual({
      'github-copilot': ['gpt-5.4', 'org/family/model'],
      custom: ['model'],
    })
  })
  test('has empty options for providers without known models', () => {
    expect(
      buildProviderModelOptions(
        { providers: { custom: {} } },
        { builtin: () => [], catalog: () => [] },
      ),
    ).toEqual({ 'github-copilot': [], custom: [] })
  })
  test('merges live model aliases, keeps upstream namespaces and ignores unrelated or invalid models', () => {
    const local = { codex: ['existing'], router: ['manual'] }
    expect(
      mergeProviderModelOptions(local, {
        data: [
          { id: 'codex/new' },
          { id: 'codex/new' },
          { id: 'router/anthropic/claude' },
          { id: 'copilot-model' },
          { id: 'other/model' },
          { id: 'codex/' },
          { id: 123 },
          null,
        ],
      }),
    ).toEqual({
      codex: ['existing', 'new'],
      router: ['anthropic/claude', 'manual'],
    })
    expect(local).toEqual({ codex: ['existing'], router: ['manual'] })
    for (const invalid of [null, {}, { data: 'invalid' }])
      expect(mergeProviderModelOptions(local, invalid)).toEqual(local)
  })
  test('deduplicates manual IDs without dropping namespaced or unknown selections', () => {
    expect(
      parseModelSelection(' vendor/model\r\nnew-model\nvendor/model\n\n'),
    ).toEqual(['vendor/model', 'new-model'])
  })
})
