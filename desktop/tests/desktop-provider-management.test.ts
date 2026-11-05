import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  invalidateConfigCache,
  type AppConfig,
} from '../../src/lib/config-store'
import { GITHUB_TOKEN_ENV } from '../../src/lib/credential-store'
import { PATHS } from '../../src/lib/paths'
import { saveProviderManagementConfig } from '../../src/lib/provider-management'
import * as githubUser from '../../src/services/github/get-user'
import { getDesktopProviderManagementConfig } from '../electron/provider-management'
import { buildServerStartEnv } from '../electron/server-start-args'

const originalConfigPath = PATHS.CONFIG_PATH
const originalTokenPath = PATHS.GITHUB_TOKEN_PATH
let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-providers-'))
  PATHS.CONFIG_PATH = path.join(directory, 'config.json')
  PATHS.GITHUB_TOKEN_PATH = path.join(directory, 'github_token')
  fs.writeFileSync(
    PATHS.CONFIG_PATH,
    JSON.stringify({
      providers: {
        codex: {
          type: 'openai-responses',
          authType: 'oauth2',
          apiKey: 'codex-secret',
        },
      },
    }),
  )
  invalidateConfigCache()
})

afterEach(() => {
  mock.restore()
  PATHS.CONFIG_PATH = originalConfigPath
  PATHS.GITHUB_TOKEN_PATH = originalTokenPath
  invalidateConfigCache()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('desktop provider management', () => {
  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', ' \r\n\t '],
  ])('omits Copilot with a %s GitHub token file', async (_label, token) => {
    if (token !== undefined) fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, token)
    const before = fs.readFileSync(PATHS.CONFIG_PATH, 'utf8')

    const config = await getDesktopProviderManagementConfig()

    expect(config.configPath).toBe(PATHS.CONFIG_PATH)
    expect(config.providers).toEqual([
      {
        name: 'codex',
        type: 'openai-responses',
        enabled: true,
        agentsModels: undefined,
      },
    ])
    expect(JSON.stringify(config)).not.toContain('secret')
    expect(fs.readFileSync(PATHS.CONFIG_PATH, 'utf8')).toBe(before)
  })

  test('keeps legacy Copilot visible with a nonempty saved token', async () => {
    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, ' github-test-token\r\n')

    const config = await getDesktopProviderManagementConfig()

    expect(config.providers.map((provider) => provider.name)).toEqual([
      'github-copilot',
      'codex',
    ])
    expect(config.providers[0]?.enabled).toBe(true)
    expect(JSON.stringify(config)).not.toContain('github-test-token')
  })

  test('shows a saved Copilot provider without revalidating its token', async () => {
    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, 'stale-token')
    const verify = spyOn(githubUser, 'getGitHubUser').mockRejectedValue(
      new Error('Revoked token'),
    )
    expect(
      (await getDesktopProviderManagementConfig()).providers.map(
        (provider) => provider.name,
      ),
    ).toEqual(['github-copilot', 'codex'])
    expect(verify).not.toHaveBeenCalled()
  })

  test('ignores an inherited token that the desktop server does not receive', async () => {
    const originalEnvToken = process.env[GITHUB_TOKEN_ENV]
    try {
      process.env[GITHUB_TOKEN_ENV] = 'inherited-github-token'
      fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, '')

      expect(buildServerStartEnv(process.env)).not.toHaveProperty(
        GITHUB_TOKEN_ENV,
      )
      expect(
        (await getDesktopProviderManagementConfig()).providers.map(
          (provider) => provider.name,
        ),
      ).toEqual(['codex'])
    } finally {
      if (originalEnvToken === undefined) delete process.env[GITHUB_TOKEN_ENV]
      else process.env[GITHUB_TOKEN_ENV] = originalEnvToken
    }
  })

  test('filters save results without changing stored Copilot settings', async () => {
    const update = {
      providers: {
        'github-copilot': { enabled: false, agentsModels: ['copilot-model'] },
        codex: { agentsModels: ['codex-model'] },
      },
    }
    const config = await getDesktopProviderManagementConfig(
      saveProviderManagementConfig(update),
    )

    expect(config.providers.map((provider) => provider.name)).toEqual(['codex'])
    expect(config.providers[0]?.agentsModels).toEqual(['codex-model'])
    const stored = fs.readFileSync(PATHS.CONFIG_PATH, 'utf8')
    const storedConfig = JSON.parse(stored) as AppConfig
    expect(storedConfig.providers?.['github-copilot']).toEqual(
      update.providers['github-copilot'],
    )
    expect(storedConfig.providers?.codex.apiKey).toBe('codex-secret')

    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, 'github-test-token')
    expect(
      (await getDesktopProviderManagementConfig()).providers,
    ).toContainEqual({
      name: 'github-copilot',
      type: 'github-copilot',
      ...update.providers['github-copilot'],
    })
    expect(fs.readFileSync(PATHS.CONFIG_PATH, 'utf8')).toBe(stored)
  })

  test('updates the list when GitHub credentials are added and cleared', async () => {
    expect((await getDesktopProviderManagementConfig()).providers).toHaveLength(
      1,
    )

    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, 'github-test-token')
    expect((await getDesktopProviderManagementConfig()).providers).toHaveLength(
      2,
    )

    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, '')
    expect((await getDesktopProviderManagementConfig()).providers).toHaveLength(
      1,
    )
  })
})
