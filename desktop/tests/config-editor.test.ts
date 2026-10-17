import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PATHS } from '../../src/lib/paths'
import {
  defaultConfig,
  invalidateConfigCache,
  writeConfigToDisk,
} from '../../src/lib/config-store'
import {
  createAppConfigEditor,
  readAppConfigDocument,
  writeAppConfigDocument,
} from '../electron/config-editor'
import { createConfigRefresher } from '../electron/config-refresh'
import {
  getConfigChanges,
  getConfigValue,
  maskConfigValue,
  parseConfigContent,
  serializeConfig,
  setConfigValue,
  validateConfigContent,
} from '../src/lib/config-editor'

const originalPath = PATHS.CONFIG_PATH
let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-config-editor-'))
  PATHS.CONFIG_PATH = path.join(directory, 'config.json')
  invalidateConfigCache()
})
afterEach(() => {
  PATHS.CONFIG_PATH = originalPath
  invalidateConfigCache()
  mock.restore()
  fs.rmSync(directory, { recursive: true, force: true })
})
function persist(config: unknown) {
  fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify(config))
}
function fixture(running = true) {
  const reload = mock((_keys: string[]) => Promise.resolve())
  const { saveAndRefresh } = createConfigRefresher({
    isRunning: () => running,
    readAdminApiKey: () =>
      Promise.resolve(
        (
          parseConfigContent(readAppConfigDocument().content).auth as
            { adminApiKey?: string } | undefined
        )?.adminApiKey ?? '',
      ),
    invalidateConfigCache,
    reloadConfig: reload,
  })
  return { editor: createAppConfigEditor({ saveAndRefresh }), reload }
}

describe('desktop configuration document', () => {
  test('reads missing, empty and corrupt files without overwriting them', () => {
    const missing = readAppConfigDocument()
    expect(missing.content).toBe('{}\n')
    expect(missing.configPath).toBe(PATHS.CONFIG_PATH)
    expect(fs.existsSync(PATHS.CONFIG_PATH)).toBe(false)
    persist({})
    expect(readAppConfigDocument().revision).not.toBe(missing.revision)
    fs.writeFileSync(PATHS.CONFIG_PATH, '')
    expect(readAppConfigDocument().content).toBe('{}\n')
    fs.writeFileSync(PATHS.CONFIG_PATH, '{"anthropicApiKey":"private-key",')
    expect(readAppConfigDocument().content).toContain('private-key')
    expect(() =>
      validateConfigContent(readAppConfigDocument().content),
    ).toThrow('Invalid JSON.')
    expect(fs.readFileSync(PATHS.CONFIG_PATH, 'utf8')).toBe(
      '{"anthropicApiKey":"private-key",',
    )
  })

  test('keeps defaults separate from the editable document', () => {
    persist({ alphaSearchModel: '', useMessagesApi: false })
    const doc = readAppConfigDocument()
    expect(parseConfigContent(doc.content)).toEqual({
      alphaSearchModel: '',
      useMessagesApi: false,
    })
    const defaults = parseConfigContent(doc.defaultContent)
    expect(defaults.useMessagesApi).toBe(true)
    expect(defaults.claudeTokenMultiplier).toBe(1.15)
    expect(() =>
      validateConfigContent(JSON.stringify(defaultConfig)),
    ).not.toThrow()
  })

  test('preserves unknown nested fields, dotted model names, false and empty strings', () => {
    const original = {
      futureField: { flag: false },
      providers: {
        custom: {
          apiKey: 'provider-secret',
          future: ['value'],
          models: { 'model.1': { futureFlag: true } },
        },
      },
      auth: { adminApiKey: 'admin-secret', apiKeys: ['gateway-secret'] },
    }
    persist(original)
    const doc = readAppConfigDocument()
    writeAppConfigDocument({
      revision: doc.revision,
      content: serializeConfig({
        ...original,
        useMessagesApi: false,
        alphaSearchModel: '',
        smallModels: { 'provider.with.dots': '' },
      }),
    })
    expect(JSON.parse(fs.readFileSync(PATHS.CONFIG_PATH, 'utf8'))).toEqual({
      ...original,
      useMessagesApi: false,
      alphaSearchModel: '',
      smallModels: { 'provider.with.dots': '' },
    })
  })

  test('rejects external edits and an unexpected file path without overwriting data', () => {
    persist({ useMessagesApi: true })
    const doc = readAppConfigDocument()
    persist({ useMessagesApi: false, external: true })
    expect(() =>
      writeAppConfigDocument({ revision: doc.revision, content: '{}' }),
    ).toThrow('changed on disk')
    expect(() =>
      writeAppConfigDocument({
        revision: doc.revision,
        content: '{}',
        configPath: 'elsewhere',
      }),
    ).toThrow('Invalid config update')
    expect(parseConfigContent(readAppConfigDocument().content).external).toBe(
      true,
    )
  })

  test('reports filesystem errors instead of replacing the file with defaults', () => {
    fs.mkdirSync(PATHS.CONFIG_PATH)
    expect(() => readAppConfigDocument()).toThrow()
  })

  test('retains the last valid disk document on validation failure', () => {
    persist({ useMessagesApi: true })
    const doc = readAppConfigDocument()
    expect(() =>
      writeAppConfigDocument({
        revision: doc.revision,
        content: '{"upstreamTransport":{"headersTimeoutMs":0}}',
      }),
    ).toThrow('headersTimeoutMs')
    expect(readAppConfigDocument()).toEqual(doc)
  })

  test('reuses the existing provider model migration on save', () => {
    const doc = readAppConfigDocument()
    writeAppConfigDocument({
      revision: doc.revision,
      content: '{"providers":{"custom":{"codexModels":["model.1"]}}}',
    })
    expect(
      parseConfigContent(readAppConfigDocument().content).providers,
    ).toEqual({ custom: { agentsModels: ['model.1'] } })
  })
})

describe('save and apply status', () => {
  test('saves offline without reporting an application or calling HTTP', async () => {
    const { editor, reload } = fixture(false)
    const doc = editor.read()
    const result = await editor.save({
      revision: doc.revision,
      content: '{"useMessagesApi":false}',
    })
    expect(result.saved).toBe(true)
    expect(result.applied).toBe(false)
    expect(result.refreshError).toBeUndefined()
    expect(reload).not.toHaveBeenCalled()
    expect(result.revision).toBe(editor.read().revision)
  })

  test('returns the final revision after reload persists defaults or a new admin key', async () => {
    persist({ auth: { adminApiKey: 'initial-admin' } })
    const { editor, reload } = fixture()
    reload.mockImplementation(async () => {
      writeConfigToDisk({
        ...validateConfigContent(editor.read().content),
        auth: { adminApiKey: 'regenerated-admin' },
        useMessagesApi: true,
      })
    })
    const doc = editor.read()
    const result = await editor.save({ revision: doc.revision, content: '{}' })
    expect(result.applied).toBe(true)
    expect(result.revision).toBe(editor.read().revision)
    expect(parseConfigContent(result.content).auth).toEqual({
      adminApiKey: 'regenerated-admin',
    })
    expect(reload).toHaveBeenCalledWith(['initial-admin'])
  })

  test('reports a successful save separately from a failed refresh and can retry', async () => {
    persist({ auth: { adminApiKey: 'active-admin' } })
    const { editor, reload } = fixture()
    reload.mockRejectedValueOnce(new Error('service unavailable'))
    const result = await editor.save({
      revision: editor.read().revision,
      content:
        '{"auth":{"adminApiKey":"rotated-admin"},"useMessagesApi":false}',
    })
    expect(result.saved).toBe(true)
    expect(result.applied).toBe(false)
    expect(result.refreshError).toBe('service unavailable')
    const retried = await editor.apply(result.revision)
    expect(retried.applied).toBe(true)
    expect(retried.content).toBe(result.content)
    expect(reload.mock.calls[1]).toEqual([['active-admin', 'rotated-admin']])
  })

  test('does not refresh failed validation, stale application requests or invalid IPC input', async () => {
    persist({ auth: { adminApiKey: 'admin' } })
    const { editor, reload } = fixture()
    const doc = editor.read()
    await expect(
      editor.save({ revision: doc.revision, content: '[]' }),
    ).rejects.toThrow('JSON object')
    await expect(editor.apply('wrong')).rejects.toThrow(
      'Invalid config revision',
    )
    await expect(editor.save(null)).rejects.toThrow('Invalid config update')
    persist({ auth: { adminApiKey: 'external' } })
    await expect(editor.apply(doc.revision)).rejects.toThrow('changed on disk')
    expect(reload).not.toHaveBeenCalled()
  })

  test('checks revision after waiting for an earlier queued save', async () => {
    persist({ auth: { adminApiKey: 'admin' } })
    const { editor, reload } = fixture()
    const gate = Promise.withResolvers<void>()
    reload.mockImplementationOnce(() => gate.promise)
    const revision = editor.read().revision
    const first = editor.save({
      revision,
      content: '{"auth":{"adminApiKey":"admin"},"alphaSearchModel":"first"}',
    })
    const second = editor.save({
      revision,
      content: '{"auth":{"adminApiKey":"admin"},"alphaSearchModel":"second"}',
    })
    gate.resolve()
    await first
    await expect(second).rejects.toThrow('changed on disk')
    expect(parseConfigContent(editor.read().content).alphaSearchModel).toBe(
      'first',
    )
  })

  test('validates the saved content when retrying application', async () => {
    fs.writeFileSync(PATHS.CONFIG_PATH, '{bad JSON')
    const { editor, reload } = fixture(false)
    await expect(editor.apply(editor.read().revision)).rejects.toThrow(
      'Invalid JSON',
    )
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('configuration validation and editing helpers', () => {
  test.each([
    '[]',
    'null',
    'true',
    '{',
    '{"useMessagesApi":"yes"}',
    '{"contextManagement":{"messages":null}}',
    '{"upstreamTransport":{"headersTimeoutMs":0}}',
    '{"opencodeModelContextWindow":1.2}',
    '{"claudeTokenMultiplier":-1}',
    '{"modelMappings":{"":"target"}}',
    '{"modelReasoningEfforts":{"model":"ultra"}}',
    '{"extraPrompts":{"model":false}}',
    '{"providers":{"custom":{"models":{"model":{"maxOutputTokens":"bad"}}}}}',
    '{"auth":{"apiKeys":[""]}}',
    '{"imageGenerationModel":"other/model"}',
    '{"smallModels":[]}',
    '{"providers":{"custom":{"enabled":"false"}}}',
    '{"anthropicApiKey":"••••••"}',
  ])('rejects invalid known config: %s', (content) => {
    expect(() => validateConfigContent(content)).toThrow()
  })

  test('keeps all supported fields and future fields while allowing inherited defaults', () => {
    const config = {
      ...defaultConfig,
      unknown: { future: ['anything'] },
      claudeAutoModel: '',
      anthropicApiKey: 'key',
      imageEditModel: 'xai/model',
      providers: {
        test: {
          type: 'future-provider',
          models: {
            m: {
              reasoningEfforts: ['ultra'],
              reasoningField: 'reasoning',
              pricing: {
                input: 2,
                tiers: [{ maxInputTokens: 1000, output: 3 }],
              },
            },
          },
        },
      },
    }
    expect(validateConfigContent(JSON.stringify(config))).toEqual(config)
    expect(validateConfigContent('{}')).toEqual({})
  })

  test('edits only the selected path, preserving defaults, unknown keys and the original object', () => {
    const config = {
      contextManagement: { messages: true, unknown: 7 },
      keep: ['x'],
    }
    const next = setConfigValue(config, 'contextManagement.messages', false)
    expect(getConfigValue(next, 'contextManagement.messages')).toBe(false)
    expect(getConfigValue(config, 'contextManagement.messages')).toBe(true)
    const inherited = setConfigValue(
      next,
      'contextManagement.messages',
      undefined,
    )
    expect(
      getConfigValue(inherited, 'contextManagement.messages'),
    ).toBeUndefined()
    expect(getConfigValue(inherited, 'contextManagement.unknown')).toBe(7)
    expect(getConfigValue(inherited, 'keep.missing')).toBeUndefined()
    expect(
      getConfigValue(
        setConfigValue({ broken: false }, 'broken.child', 1),
        'broken.child',
      ),
    ).toBe(1)
    expect(getConfigValue({}, 'toString')).toBeUndefined()
    const special = setConfigValue({}, '__proto__.flag', true)
    expect(getConfigValue(special, '__proto__.flag')).toBe(true)
    expect(Object.hasOwn(Object.prototype, 'flag')).toBe(false)
  })

  test('masks nested and future credential fields, including arrays and secret removal diffs', () => {
    const before = {
      auth: { apiKeys: ['secret'], adminApiKey: 'admin' },
      providers: { p: { apiKey: 'provider' } },
      future: [{ access_token: 'access' }],
    }
    const masked = JSON.stringify(maskConfigValue(before))
    for (const secret of ['"secret"', '"admin"', '"provider"', '"access"'])
      expect(masked).not.toContain(secret)
    expect(masked).toContain('••••••')
    expect(maskConfigValue(false)).toBe(false)
    expect(
      maskConfigValue({ claudeTokenMultiplier: 1.15, maxOutputTokens: 64000 }),
    ).toEqual({ claudeTokenMultiplier: 1.15, maxOutputTokens: 64000 })
    const changes = getConfigChanges(before, {
      ...before,
      auth: { apiKeys: [], adminApiKey: 'new-admin' },
      providers: {},
    })
    expect(changes.length).toBe(3)
    expect(JSON.stringify(changes)).not.toContain('new-admin')
    expect(JSON.stringify(changes)).not.toContain('"provider"')
    expect(
      getConfigChanges({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }),
    ).toEqual([])
  })
})
