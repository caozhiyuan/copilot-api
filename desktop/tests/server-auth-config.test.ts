import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PATHS } from '../../src/lib/storage/paths'
import {
  parseApiKeyQuotaUsage,
  readManagedApiKeys,
  readServerKeysConfig,
  writeServerKeysConfig,
} from '../electron/server-auth-config'
import type { GatewayApiKeyConfig } from '../src/types/ipc'

const moduleUrl = pathToFileURL(
  path.join(import.meta.dir, '../electron/server-auth-config.ts'),
).href

interface ConfigFileShape {
  auth?: {
    apiKeys?: string[]
    apiKeyConfigs?: GatewayApiKeyConfig[]
    adminApiKey?: string
    isolateApiKeyUsage?: boolean
  }
  providers?: Record<string, unknown>
  modelMappings?: Record<string, string>
}

async function runScript(
  homeDir: string,
  script: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, '-e', script], {
    env: {
      ...process.env,
      COPILOT_API_HOME: homeDir,
      COPILOT_API_OAUTH_APP: '',
      COPILOT_API_ENTERPRISE_URL: '',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function writeConfig(
  homeDir: string,
  config: ConfigFileShape,
): Promise<string> {
  const configPath = path.join(homeDir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
  return configPath
}

describe('desktop server-auth-config', () => {
  test('validates quota usage returned by the gateway', () => {
    const usage = [
      { id: 'daily', usedAmount: 1.5, remainingAmount: 0, resetsAt: 12345 },
      { id: 'unlimited', usedAmount: 0, remainingAmount: null, resetsAt: null },
    ]
    expect(parseApiKeyQuotaUsage(usage)).toEqual(usage)
    expect(() => parseApiKeyQuotaUsage({ usage })).toThrow(
      'Failed to load API key quotas',
    )
    expect(() =>
      parseApiKeyQuotaUsage([{ ...usage[0], remainingAmount: '0' }]),
    ).toThrow('Failed to load API key quotas')
  })

  test('uses active managed keys for Desktop requests and keeps inactive keys editable', async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'copilot-api-server-auth-'),
    )
    const originalPath = PATHS.CONFIG_PATH
    try {
      PATHS.CONFIG_PATH = await writeConfig(homeDir, {
        auth: {
          apiKeys: ['retired-key'],
          apiKeyConfigs: [
            { id: 'disabled', key: 'key-off', enabled: false },
            {
              id: 'expired',
              key: 'key-expired',
              expiresAt: '2000-01-01T00:00:00Z',
            },
            { id: 'active', key: 'rotated-key' },
          ],
        },
      })
      expect((await readServerKeysConfig()).apiKeys).toEqual(['rotated-key'])
      expect(readManagedApiKeys().map((key) => key.id)).toEqual([
        'disabled',
        'expired',
        'active',
      ])
    } finally {
      PATHS.CONFIG_PATH = originalPath
      await fs.rm(homeDir, { force: true, recursive: true })
    }
  })

  test('reads and normalizes stored API keys and admin key', async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'copilot-api-server-auth-'),
    )
    try {
      await writeConfig(homeDir, {
        auth: {
          apiKeys: [' key-1 ', 'key-2'],
          adminApiKey: ' admin-key ',
        },
      })
      const script = `import { readServerKeysConfig } from ${JSON.stringify(moduleUrl)}
process.stdout.write(JSON.stringify(await readServerKeysConfig()))`
      const result = await runScript(homeDir, script)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual({
        apiKeys: ['key-1', 'key-2'],
        adminApiKey: 'admin-key',
      })
    } finally {
      await fs.rm(homeDir, { force: true, recursive: true })
    }
  })

  test('writes normalized keys and preserves other config fields', async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'copilot-api-server-auth-'),
    )
    try {
      const configPath = await writeConfig(homeDir, {
        auth: {
          apiKeys: ['old-key'],
          adminApiKey: 'old-admin',
        },
        providers: { example: { apiKey: 'provider-key' } },
        modelMappings: { old: 'new' },
      })
      const script = `import fs from 'node:fs/promises'
import { writeServerKeysConfig } from ${JSON.stringify(moduleUrl)}
      const saved = writeServerKeysConfig({ apiKeys: [' key-1 ', 'key-1', ' key-2 '], adminApiKey: ' admin-key ' })
const raw = JSON.parse(await fs.readFile(${JSON.stringify(configPath)}, 'utf8'))
process.stdout.write(JSON.stringify({ saved, raw }))`
      const result = await runScript(homeDir, script)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      const parsed = JSON.parse(result.stdout) as {
        saved: { apiKeys: string[]; adminApiKey: string }
        raw: ConfigFileShape
      }
      expect(parsed.saved).toEqual({
        apiKeys: ['key-1', 'key-2'],
        adminApiKey: 'admin-key',
      })
      expect(parsed.raw.auth?.apiKeyConfigs?.map((key) => key.key)).toEqual([
        'key-1',
        'key-2',
      ])
      expect(parsed.raw.auth?.adminApiKey).toBe('admin-key')
      expect(parsed.raw.providers).toEqual({
        example: { apiKey: 'provider-key' },
      })
      expect(parsed.raw.modelMappings).toEqual({ old: 'new' })
    } finally {
      await fs.rm(homeDir, { force: true, recursive: true })
    }
  })

  test.each([
    [
      'partial usage isolation update',
      { isolateApiKeyUsage: true },
      {
        apiKeys: ['key-1'],
        adminApiKey: 'old-admin',
        isolateApiKeyUsage: true,
      },
    ],
    [
      'partial usage isolation disable',
      { isolateApiKeyUsage: false },
      {
        apiKeys: ['key-1'],
        adminApiKey: 'old-admin',
        isolateApiKeyUsage: false,
      },
    ],
    [
      'partial API keys update',
      { apiKeys: [' new-key '] },
      { apiKeys: ['new-key'], adminApiKey: 'old-admin' },
    ],
    [
      'partial admin key update',
      { adminApiKey: ' new-admin ' },
      { apiKeys: ['key-1'], adminApiKey: 'new-admin' },
    ],
    [
      'partial admin key removal',
      { adminApiKey: '' },
      { apiKeys: ['key-1'], adminApiKey: '' },
    ],
    [
      'full admin key removal',
      { apiKeys: ['key-1'], adminApiKey: '' },
      { apiKeys: ['key-1'], adminApiKey: '' },
    ],
  ] satisfies Array<
    [
      string,
      ConfigFileShape['auth'],
      { apiKeys: string[]; adminApiKey: string; isolateApiKeyUsage?: boolean },
    ]
  >)(
    '%s preserves unrelated auth fields on disk',
    async (_scenario, update, expected) => {
      const homeDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'copilot-api-server-auth-'),
      )
      try {
        const configPath = await writeConfig(homeDir, {
          auth: { apiKeys: ['key-1'], adminApiKey: 'old-admin' },
        })
        const script = `import fs from 'node:fs/promises'
import { writeServerKeysConfig } from ${JSON.stringify(moduleUrl)}
const saved = writeServerKeysConfig(${JSON.stringify(update)})
const raw = JSON.parse(await fs.readFile(${JSON.stringify(configPath)}, 'utf8'))
process.stdout.write(JSON.stringify({ saved, raw }))`
        const result = await runScript(homeDir, script)
        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe('')
        const parsed = JSON.parse(result.stdout) as {
          saved: { apiKeys: string[]; adminApiKey: string }
          raw: ConfigFileShape
        }
        expect(parsed.saved).toEqual(expected)
        expect(parsed.raw.auth?.apiKeyConfigs?.map((key) => key.key)).toEqual(
          expected.apiKeys,
        )
        expect(parsed.raw.auth?.adminApiKey).toBe(
          expected.adminApiKey || undefined,
        )
        expect(parsed.raw.auth?.apiKeys).toEqual(['key-1'])
        expect(parsed.raw.auth?.isolateApiKeyUsage).toBe(
          'isolateApiKeyUsage' in expected ?
            expected.isolateApiKeyUsage
          : undefined,
        )
      } finally {
        await fs.rm(homeDir, { force: true, recursive: true })
      }
    },
  )

  test('reads empty config when the file is missing and writes create it', async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'copilot-api-server-auth-'),
    )
    try {
      const configPath = path.join(homeDir, 'config.json')
      const script = `import fs from 'node:fs/promises'
import { readServerKeysConfig, writeServerKeysConfig } from ${JSON.stringify(moduleUrl)}
      const before = await readServerKeysConfig()
const saved = writeServerKeysConfig({ apiKeys: ['key-1'], adminApiKey: '' })
const raw = JSON.parse(await fs.readFile(${JSON.stringify(configPath)}, 'utf8'))
process.stdout.write(JSON.stringify({ before, saved, raw }))`
      const result = await runScript(homeDir, script)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      const parsed = JSON.parse(result.stdout) as {
        before: { apiKeys: string[]; adminApiKey: string }
        saved: { apiKeys: string[]; adminApiKey: string }
        raw: ConfigFileShape
      }
      expect(parsed.before).toEqual({ apiKeys: [], adminApiKey: '' })
      expect(parsed.saved).toEqual({ apiKeys: ['key-1'], adminApiKey: '' })
      expect(parsed.raw.auth?.apiKeyConfigs?.map((key) => key.key)).toEqual([
        'key-1',
      ])
    } finally {
      await fs.rm(homeDir, { force: true, recursive: true })
    }
  })

  test('reads isolation, preserves it during other auth changes and rejects invalid switches', async () => {
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'copilot-api-server-auth-'),
    )
    const originalPath = PATHS.CONFIG_PATH
    try {
      PATHS.CONFIG_PATH = await writeConfig(homeDir, {
        auth: {
          apiKeys: ['key-1'],
          adminApiKey: 'admin',
          isolateApiKeyUsage: true,
        },
      })
      expect((await readServerKeysConfig()).isolateApiKeyUsage).toBe(true)
      writeServerKeysConfig({ adminApiKey: 'rotated' })
      expect(await readServerKeysConfig()).toEqual({
        apiKeys: ['key-1'],
        adminApiKey: 'rotated',
        isolateApiKeyUsage: true,
      })
      writeServerKeysConfig({ isolateApiKeyUsage: false })
      expect((await readServerKeysConfig()).isolateApiKeyUsage).toBe(false)
      expect(() => {
        Reflect.apply(writeServerKeysConfig, undefined, [
          { isolateApiKeyUsage: 'true' },
        ])
      }).toThrow('Usage isolation must be a boolean')
    } finally {
      PATHS.CONFIG_PATH = originalPath
      await fs.rm(homeDir, { force: true, recursive: true })
    }
  })
})
