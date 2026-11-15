import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  patchJsonConfig,
  patchEnvConfig,
  patchTomlConfig,
  readJsonConfig,
  readTomlConfig,
} from '../electron/client-config'
import {
  createClientIntegrations,
  clientIntegrationReply,
} from '../electron/client-integrations'
import {
  CODEX_CLIENT_DEFAULTS,
  type ClientId,
  type ClientSetupInput,
  type CodexClientOptions,
} from '../shared/client-integrations'
import { ClientCommandError } from '../electron/client-command'

let directory: string
let environment: string | null
let run: ReturnType<
  typeof mock<
    (
      command: 'claude' | 'dsh',
      args: string[],
    ) => Promise<{ stdout: string; stderr: string }>
  >
>
let writeEnvironment: ReturnType<
  typeof mock<(value: string | null) => Promise<void>>
>
let gateway: { baseUrl: string; apiKeys: string[] }
const resourceDir = path.resolve(import.meta.dir, '../..')
const originalFetch = globalThis.fetch

function fixture(
  extra: Partial<Parameters<typeof createClientIntegrations>[0]> = {},
) {
  return createClientIntegrations({
    homeDir: directory,
    dataDir: path.join(directory, 'backups'),
    resourceDir,
    platform: 'linux',
    env: {},
    getGateway: () => Promise.resolve(gateway),
    runCommand: run,
    readEnvironment: () => Promise.resolve(environment),
    writeEnvironment,
    ...extra,
  })
}
function persist(file: string, content: string) {
  const destination = path.join(directory, file)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, content)
}
function read(file: string) {
  return fs.readFileSync(path.join(directory, file), 'utf8')
}
async function input(
  manager: ReturnType<typeof fixture>,
  client: ClientId,
  overrides: Partial<ClientSetupInput> = {},
): Promise<ClientSetupInput> {
  const status = await manager.status(client)
  return {
    client,
    revision: status.revision,
    apiKey: gateway.apiKeys[0] ?? 'dummy',
    model:
      client === 'claude' ?
        'codex/my-claude-gpt-6.1-sol[1m]'
      : 'codex/gpt-6.1-sol',
    fableModel: status.fableModel,
    opusModel: status.opusModel,
    sonnetModel: status.sonnetModel,
    smallModel: '',
    reviewModel: status.reviewModel,
    nativeToolSearch: false,
    agentContext: false,
    plugins: [],
    ...overrides,
  }
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'client-integrations-'))
  environment = null
  run = mock(() => Promise.resolve({ stdout: '', stderr: '' }))
  writeEnvironment = mock((value) => {
    environment = value
    return Promise.resolve()
  })
  gateway = { baseUrl: 'http://localhost:5141', apiKeys: ['test-gateway-key'] }
})
afterEach(() => {
  globalThis.fetch = originalFetch
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('comment-preserving client config edits', () => {
  test('updates managed dotenv values without changing existing variables or comments', () => {
    const source =
      '# keep\r\nOTHER="first\r\nsecond"\r\nGITHUB_COPILOT_API_KEY=old\r\n'
    const values = {
      COPILOT_API_BASE_URL: 'http://localhost:5141',
      GITHUB_COPILOT_API_KEY: `key'"$#\\n`,
    }
    const changed = patchEnvConfig(source, values)
    expect(changed).toStartWith(source)
    expect(parseEnv(changed)).toMatchObject(values)
    expect(parseEnv(changed).OTHER).toBe(parseEnv(source).OTHER)
    expect(patchEnvConfig(changed, values)).toBe(changed)
    expect(
      parseEnv(
        patchEnvConfig(changed, { ...values, GITHUB_COPILOT_API_KEY: 'new' }),
      ).GITHUB_COPILOT_API_KEY,
    ).toBe('new')
    expect(parseEnv(patchEnvConfig('', { KEY: 'plain' })).KEY).toBe('plain')
    expect(parseEnv(patchEnvConfig('', { KEY: `all'"\`quotes` })).KEY).toBe(
      `all'"\`quotes`,
    )
    expect(() => patchEnvConfig('', { 'invalid-key': 'value' })).toThrow(
      'invalidInput',
    )
    expect(() => patchEnvConfig('', { KEY: `'"\`#` })).toThrow('invalidInput')
    expect(() =>
      patchEnvConfig('# >>> copilot-api Harness >>>', values),
    ).toThrow('invalidConfig')
    expect(() =>
      patchEnvConfig('# <<< copilot-api Harness <<<', values),
    ).toThrow('invalidConfig')
    expect(() => patchEnvConfig('OTHER="unfinished\n', values)).toThrow(
      'invalidConfig',
    )
  })
  test('merges JSONC without removing comments or unrelated settings', () => {
    const source =
      '{\n  // Keep this\n  "env": {"OTHER": "yes",},\n  "permissions": {"deny": ["Read(.env)"]},\n}\n'
    const result = patchJsonConfig(source, [
      [['env', 'ANTHROPIC_BASE_URL'], 'http://localhost:5141'],
      [['model'], 'my-model'],
    ])
    expect(result).toContain('// Keep this')
    expect(readJsonConfig(result)).toMatchObject({
      env: { OTHER: 'yes', ANTHROPIC_BASE_URL: 'http://localhost:5141' },
      permissions: { deny: ['Read(.env)'] },
      model: 'my-model',
    })
    expect(patchJsonConfig('', [[['model'], 'test']])).toContain('test')
    expect(() => patchJsonConfig('[1]', [])).toThrow('invalidConfig')
    expect(() => readJsonConfig('{broken')).toThrow('invalidConfig')
  })
  test('preserves TOML comments, quoted keys, multiline values and other tables', () => {
    const source =
      '# Header\nmodel = "old" # main model\nnotes = """\n[model_providers.fake]\nnot a table\n"""\n[model_providers."copilot_api"]\nbase_url = "old" # keep\nother = true\n[features]\ninstant_interrupt = true\nkeep = true\n[projects."/work"]\ntrust_level = "trusted"\n'
    const result = patchTomlConfig(source, [
      [['model'], 'new'],
      [['model_providers', 'copilot_api', 'base_url'], 'http://localhost:5141'],
      [['model_providers', 'copilot_api', 'env_key'], 'GITHUB_COPILOT_API_KEY'],
      [['features', 'instant_interrupt'], false],
    ])
    expect(result).toContain('# Header')
    expect(result).toContain('"new" # main model')
    expect(result).toContain('"http://localhost:5141" # keep')
    expect(result).toContain('[projects."/work"]\ntrust_level = "trusted"')
    expect(readTomlConfig(result)).toMatchObject({
      model: 'new',
      model_providers: { copilot_api: { other: true } },
      features: { keep: true, instant_interrupt: false },
    })
  })
  test('updates inline/dotted tables, CRLF and files without a final newline', () => {
    for (const source of [
      'model_providers = { copilot_api = { base_url = "old" } }\r\n',
      'model_providers.copilot_api.base_url = "old"',
      '[model_providers.copilot_api]\r\nbase_url = "old"\r\n',
      'model_providers = {}',
    ]) {
      const result = patchTomlConfig(source, [
        [['model_providers', 'copilot_api', 'base_url'], 'new'],
        [['model_providers', 'copilot_api', 'env_key'], 'KEY'],
        [['model'], 'gpt'],
      ])
      expect(readTomlConfig(result)).toMatchObject({
        model: 'gpt',
        model_providers: { copilot_api: { base_url: 'new', env_key: 'KEY' } },
      })
    }
    expect(() => patchTomlConfig('[broken', [[['model'], 'new']])).toThrow(
      'invalidConfig',
    )
    expect(() =>
      patchTomlConfig('features = false', [
        [['features', 'instant_interrupt'], false],
      ]),
    ).toThrow('invalidConfig')
  })
})

describe('client setup and restore', () => {
  test('inspects all clients without creating any files and respects custom config homes', async () => {
    const manager = fixture({
      env: {
        CLAUDE_CONFIG_DIR: path.join(directory, 'claude-custom'),
        CODEX_HOME: path.join(directory, 'codex-custom'),
        XDG_CONFIG_HOME: path.join(directory, 'xdg'),
      },
    })
    const state = await manager.getState()
    expect(state.clients.map((client) => client.state)).toEqual([
      'unconfigured',
      'unconfigured',
      'unconfigured',
    ])
    expect(state.clients[0].configPath).toContain('claude-custom')
    expect(state.clients[1].configPath).toContain(path.join('xdg', 'opencode'))
    expect(state.clients[2].configPath).toContain('codex-custom')
    expect(fs.readdirSync(directory)).toEqual([])
  })
  test('inspects only the requested agent and skips unrelated environment and profile checks', async () => {
    persist('.dsh/profiles/web.yaml', '# profile')
    const readEnvironment = mock(() => Promise.resolve(null))
    const manager = fixture({ readEnvironment })
    for (const agent of ['claude', 'opencode'] as const) {
      const state = await manager.getState(agent)
      expect(state.clients.map((item) => item.client)).toEqual([agent])
      expect(state.harnessProfiles).toEqual([])
    }
    const harness = await manager.getState('harness')
    expect(harness.clients.map((item) => item.client)).toEqual(['harness'])
    expect(harness.harnessProfiles).toEqual(['web'])
    expect(readEnvironment).not.toHaveBeenCalled()
    expect(
      (await manager.getState('codex')).clients.map((item) => item.client),
    ).toEqual(['codex'])
    expect(readEnvironment).toHaveBeenCalledTimes(1)
    await expect(manager.getState('invalid-agent')).rejects.toThrow(
      'invalidInput',
    )
  })
  test('configures Claude default and fast models and restores the exact original JSONC', async () => {
    const source =
      '{\n // keep my permissions\n "model": "old", "env": {"OTHER":"keep","ANTHROPIC_MODEL":"pinned","CLAUDE_CODE_USE_BEDROCK":"1"}, "permissions": {"deny":["Read(.env)"]}\n}\n'
    persist('.claude/settings.json', source)
    const manager = fixture()
    const result = await manager.setup(
      await input(manager, 'claude', {
        smallModel: 'my-claude-gpt-6-luna[1m]',
      }),
    )
    expect(result.status.state).toBe('configured')
    const config = readJsonConfig(read('.claude/settings.json'))
    expect(config).toMatchObject({
      model: 'codex/my-claude-gpt-6.1-sol[1m]',
      env: {
        OTHER: 'keep',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'codex/my-claude-gpt-6.1-sol[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-claude-gpt-6-luna[1m]',
        ANTHROPIC_BASE_URL: gateway.baseUrl,
        ANTHROPIC_AUTH_TOKEN: 'test-gateway-key',
      },
    })
    expect(read('.claude/settings.json')).toContain('// keep my permissions')
    const envFields = readJsonConfig(read('.claude/settings.json'))
      .env as Record<string, unknown>
    expect(envFields).not.toHaveProperty('ANTHROPIC_MODEL')
    expect(envFields).not.toHaveProperty('CLAUDE_CODE_AUTO_MODE_MODEL')
    expect(envFields).toMatchObject({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
      CLAUDE_CODE_AUTO_MODE_SERVER: '0',
      CLAUDE_CODE_USE_VERTEX: '0',
      CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_USE_FOUNDRY: '0',
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: 'true',
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      MCP_CONNECT_TIMEOUT_MS: '20000',
    })
    expect(run).not.toHaveBeenCalled()
    const backup = path.join(directory, 'backups', 'claude.json')
    expect(fs.existsSync(backup)).toBe(true)
    if (process.platform !== 'win32')
      expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
    await manager.restore('claude', result.status.revision)
    expect(read('.claude/settings.json')).toBe(source)
    expect((await manager.status('claude')).canRestore).toBe(false)
  })
  test('disables an existing Foundry connection and restores its exact original settings', async () => {
    const source =
      '{\n // Foundry connection\n "env":{"CLAUDE_CODE_USE_FOUNDRY":"1","ANTHROPIC_FOUNDRY_RESOURCE":"original-resource","ANTHROPIC_FOUNDRY_API_KEY":"original-foundry-key"}\n}\n'
    persist('.claude/settings.json', source)
    const manager = fixture()
    const configured = await manager.setup(await input(manager, 'claude'))
    expect(configured.status.state).toBe('configured')
    expect(readJsonConfig(read('.claude/settings.json')).env).toMatchObject({
      CLAUDE_CODE_USE_FOUNDRY: '0',
      ANTHROPIC_BASE_URL: gateway.baseUrl,
      ANTHROPIC_AUTH_TOKEN: gateway.apiKeys[0],
      ANTHROPIC_FOUNDRY_RESOURCE: 'original-resource',
      ANTHROPIC_FOUNDRY_API_KEY: 'original-foundry-key',
    })
    expect(run).not.toHaveBeenCalled()
    await manager.restore('claude', configured.status.revision)
    expect(read('.claude/settings.json')).toBe(source)
  })

  test('saves four independent Claude aliases and the selected review model, and clears an unselected review', async () => {
    const manager = fixture()
    const choices = {
      fableModel: 'fable/custom-model',
      opusModel: 'opus/custom-model',
      sonnetModel: 'sonnet/custom-model',
      smallModel: 'haiku/custom-model',
      reviewModel: 'review/custom-model',
    }
    const configured = await manager.setup(
      await input(manager, 'claude', choices),
    )
    expect(configured.status).toMatchObject(choices)
    expect(readJsonConfig(read('.claude/settings.json')).env).toMatchObject({
      ANTHROPIC_DEFAULT_FABLE_MODEL: choices.fableModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: choices.opusModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: choices.sonnetModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: choices.smallModel,
      CLAUDE_CODE_AUTO_MODE_MODEL: choices.reviewModel,
    })
    const cleared = await manager.setup(
      await input(manager, 'claude', { ...choices, reviewModel: '' }),
    )
    expect(cleared.status.reviewModel).toBe('')
    expect(
      readJsonConfig(read('.claude/settings.json')).env,
    ).not.toHaveProperty('CLAUDE_CODE_AUTO_MODE_MODEL')
    await manager.restore('claude', cleared.status.revision)
    expect(fs.existsSync(path.join(directory, '.claude/settings.json'))).toBe(
      false,
    )
  })
  test('preserves custom Claude environment defaults, including empty values, across updates', async () => {
    const custom = {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
      CLAUDE_CODE_AUTO_MODE_SERVER: '1',
      CLAUDE_CODE_AUTO_MODE_MODEL: 'custom-review',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '',
      MCP_CONNECT_TIMEOUT_MS: '45000',
    }
    const source = JSON.stringify({ env: custom })
    persist('.claude/settings.json', source)
    const manager = fixture()
    await manager.setup(await input(manager, 'claude'))
    expect(readJsonConfig(read('.claude/settings.json')).env).toMatchObject({
      ...custom,
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
    })
    const result = await manager.setup(await input(manager, 'claude'))
    expect(readJsonConfig(read('.claude/settings.json')).env).toMatchObject(
      custom,
    )
    await manager.restore('claude', result.status.revision)
    expect(read('.claude/settings.json')).toBe(source)
  })
  test('keeps the first backup across repeated updates and uses dummy only without gateway auth', async () => {
    gateway.apiKeys = []
    const manager = fixture()
    const initial = await input(manager, 'claude')
    await expect(
      manager.setup({ ...initial, apiKey: 'not-dummy' }),
    ).rejects.toThrow('invalidKey')
    await manager.setup(initial)
    const first = read('.claude/settings.json')
    await manager.setup(await input(manager, 'claude'))
    expect(read('.claude/settings.json')).toBe(first)
    const state = await manager.status('claude')
    await manager.restore('claude', state.revision)
    expect(fs.existsSync(path.join(directory, '.claude/settings.json'))).toBe(
      false,
    )
  })
  test('rejects stale revisions, later manual edits, invalid inputs and symlinks', async () => {
    const manager = fixture()
    const stale = await input(manager, 'claude')
    persist('.claude/settings.json', '{"external":true}')
    await expect(manager.setup(stale)).rejects.toThrow('conflict')
    const configured = await manager.setup(await input(manager, 'claude'))
    persist(
      '.claude/settings.json',
      read('.claude/settings.json') + '\n// external edit',
    )
    await expect(
      manager.restore('claude', configured.status.revision),
    ).rejects.toThrow('conflict')
    await expect(
      manager.restore('claude', (await manager.status('claude')).revision),
    ).rejects.toThrow('conflict')
    await expect(manager.setup({ ...stale, model: '' })).rejects.toThrow(
      'invalidInput',
    )
    await expect(
      manager.setup({ ...stale, apiKey: 'key\nline' }),
    ).rejects.toThrow('invalidInput')
    fs.rmSync(path.join(directory, '.claude/settings.json'))
    persist('linked.json', '{}')
    fs.symlinkSync(
      path.join(directory, 'linked.json'),
      path.join(directory, '.claude/settings.json'),
    )
    expect((await manager.status('claude')).error).toBe('symlinkConfig')
    await expect(manager.setup(await input(manager, 'claude'))).rejects.toThrow(
      'symlinkConfig',
    )
    expect(read('linked.json')).toBe('{}')
  })
  test('installs the actual OpenCode v2 provider and passes custom URL/key at runtime', async () => {
    const manager = fixture()
    const result = await manager.setup(
      await input(manager, 'opencode', { agentContext: true }),
    )
    expect(result.status.state).toBe('configured')
    expect(result.status.agentContext).toBe(true)
    const fetchMock = mock(() =>
      Promise.resolve(
        Response.json({
          data: [{ id: 'model', modelID: 'model', capabilities: {}, cost: [] }],
        }),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const imported = (await import(
      pathToFileURL(
        path.join(
          directory,
          '.config/opencode/plugins/copilot-api-provider.js',
        ),
      ).href
    )) as { default: { setup: (ctx: unknown) => Promise<void> } }
    const add = mock()
    await imported.default.setup({
      options: { refreshIntervalMs: 0 },
      provider: { transform: (fn: (editor: unknown) => void) => fn({ add }) },
    })
    expect(fetchMock.mock.calls[0]).toMatchObject([
      `${gateway.baseUrl}/v1/models`,
      { headers: { 'x-api-key': 'test-gateway-key' } },
    ])
    expect(add.mock.calls[0][0]).toMatchObject({
      info: {
        settings: {
          baseURL: `${gateway.baseUrl}/v1`,
          apiKey: 'test-gateway-key',
          compaction: { type: 'native' },
        },
      },
    })
    await manager.setup(
      await input(manager, 'opencode', { agentContext: false }),
    )
    expect(
      fs.existsSync(
        path.join(directory, '.config/opencode/plugins/agent-context.js'),
      ),
    ).toBe(false)
    await manager.restore(
      'opencode',
      (await manager.status('opencode')).revision,
    )
    expect(
      fs.existsSync(
        path.join(
          directory,
          '.config/opencode/plugins/copilot-api-provider.js',
        ),
      ),
    ).toBe(false)
  })
  test('reports outdated gateway/key/plugin resources and repairs only its managed files', async () => {
    persist('.config/opencode/opencode.json', '{"theme":"mine"}')
    const manager = fixture()
    await manager.setup(await input(manager, 'opencode'))
    gateway.baseUrl = 'http://localhost:6161'
    expect((await manager.status('opencode')).state).toBe('outdated')
    await manager.setup(await input(manager, 'opencode'))
    persist('.config/opencode/copilot-api/provider.js', '// old plugin')
    expect((await manager.status('opencode')).state).toBe('outdated')
    await manager.setup(await input(manager, 'opencode'))
    expect((await manager.status('opencode')).state).toBe('configured')
    expect(read('.config/opencode/opencode.json')).toBe('{"theme":"mine"}')
  })
  test('configures Codex without changing sign-in or unrelated settings and restores an absent environment value after updates', async () => {
    const source =
      '# original\nmodel = "old"\n[features]\nkeep = true\n[projects."/work"]\ntrust_level = "trusted"\n'
    persist('.codex/config.toml', source)
    persist('.codex/auth.json', '{"login":"keep"}')
    persist('.bashrc', '# shell settings\n')
    const manager = fixture()
    await manager.setup(await input(manager, 'codex'))
    const rendered = read('.codex/config.toml')
    for (const section of [
      'model_providers.copilot_api',
      'features',
      'desktop',
      'analytics',
    ])
      expect(rendered).toContain(`[${section}]\n`)
    expect(rendered).not.toMatch(
      /^(model_providers|features|desktop|analytics)\./m,
    )
    expect(rendered).toContain(
      'enabled-reasoning-efforts = ["low", "medium", "high", "xhigh", "ultra", "max"]',
    )
    expect(readTomlConfig(read('.codex/config.toml'))).toMatchObject({
      model: 'codex/gpt-6.1-sol',
      model_reasoning_effort: 'max',
      model_reasoning_summary: 'auto',
      plan_mode_reasoning_effort: 'max',
      model_context_window: 400000,
      sandbox_mode: 'danger-full-access',
      approvals_reviewer: 'auto_review',
      suppress_unstable_features_warning: true,
      web_search: 'live',
      service_tier: 'default',
      model_provider: 'copilot_api',
      model_providers: {
        copilot_api: {
          base_url: gateway.baseUrl,
          model_catalog_url: `${gateway.baseUrl}/models`,
          name: 'OpenAI',
          env_key: 'GITHUB_COPILOT_API_KEY',
          requires_openai_auth: true,
          wire_api: 'responses',
          supports_websockets: false,
          supports_standalone_web_search: true,
          request_max_retries: 3,
          stream_max_retries: 3,
          stream_idle_timeout_ms: 300000,
        },
      },
      features: {
        keep: true,
        instant_interrupt: false,
        remote_compaction_v2: true,
        api_key_model_discovery: true,
        default_mode_request_user_input: true,
        standalone_web_search: true,
        daemon_auto_start: false,
        prevent_idle_sleep: true,
        defer_mailbox_preemption: true,
      },
      analytics: { enabled: false },
      desktop: {
        'enabled-reasoning-efforts': [
          'low',
          'medium',
          'high',
          'xhigh',
          'ultra',
          'max',
        ],
      },
    })
    expect(read('.codex/auth.json')).toBe('{"login":"keep"}')
    expect(read('.bashrc')).toStartWith('# shell settings\n')
    await manager.setup(await input(manager, 'codex'))
    expect((await manager.status('codex')).state).toBe('configured')
    await manager.restore('codex', (await manager.status('codex')).revision)
    expect(environment).toBeNull()
    expect(read('.codex/config.toml')).toBe(source)
    expect(read('.bashrc')).toBe('# shell settings\n')
    expect(fs.existsSync(path.join(directory, '.profile'))).toBe(false)
  })
  test('fills empty Codex defaults and retains nonempty custom values, false and zero', async () => {
    const source =
      'model_reasoning_effort = "high"\nmodel_reasoning_summary = ""\nmodel_context_window = ""\nservice_tier = " "\nsandbox_mode = "read-only"\nsuppress_unstable_features_warning = false\n[features]\nremote_compaction_v2 = false\napi_key_model_discovery = false\ninstant_interrupt = true\ndaemon_auto_start = true\n[desktop]\nenabled-reasoning-efforts = []\n[analytics]\nenabled = true\n[model_providers.copilot_api]\nrequest_max_retries = 0\nstream_max_retries = 8\nstream_idle_timeout_ms = 12345\nsupports_standalone_web_search = false\n'
    persist('.codex/config.toml', source)
    const manager = fixture()
    await manager.setup(await input(manager, 'codex'))
    const updated = read('.codex/config.toml')
    expect(readTomlConfig(updated)).toMatchObject({
      model_reasoning_effort: 'high',
      model_reasoning_summary: 'auto',
      model_context_window: 400000,
      service_tier: 'default',
      sandbox_mode: 'read-only',
      suppress_unstable_features_warning: false,
      features: {
        remote_compaction_v2: false,
        api_key_model_discovery: false,
        instant_interrupt: true,
        daemon_auto_start: true,
      },
      analytics: { enabled: true },
      desktop: {
        'enabled-reasoning-efforts': [
          'low',
          'medium',
          'high',
          'xhigh',
          'ultra',
          'max',
        ],
      },
      model_providers: {
        copilot_api: {
          request_max_retries: 0,
          stream_max_retries: 8,
          stream_idle_timeout_ms: 12345,
          supports_standalone_web_search: false,
        },
      },
    })
    await manager.setup(await input(manager, 'codex'))
    expect(read('.codex/config.toml')).toBe(updated)
  })
  test('reports Codex option defaults without creating configuration files', async () => {
    const manager = fixture()
    expect((await manager.status('codex')).codex).toEqual({
      ...CODEX_CLIENT_DEFAULTS,
      reasoningEffort: '',
    })
    expect(fs.readdirSync(directory)).toEqual([])
  })
  test.each([
    { ...CODEX_CLIENT_DEFAULTS },
    {
      sandboxMode: 'read-only',
      approvalsReviewer: 'user',
      webSearch: 'disabled',
      reasoningEffort: 'none',
      daemonAutoStart: true,
      defaultModeRequestUserInput: false,
      preventIdleSleep: false,
    },
    {
      ...CODEX_CLIENT_DEFAULTS,
      sandboxMode: 'workspace-write',
      webSearch: 'cached',
      reasoningEffort: 'high',
    },
    {
      ...CODEX_CLIENT_DEFAULTS,
      webSearch: 'indexed',
      reasoningEffort: 'xhigh',
    },
  ] satisfies CodexClientOptions[])(
    'saves selected Codex options and feature switches and restores their original values: $webSearch',
    async (codex) => {
      const source =
        '# original options\r\nmodel_reasoning_effort = "low" # keep effort comment\r\nsandbox_mode = "read-only"\r\napprovals_reviewer = "user"\r\nweb_search = "cached"\r\n[features]\r\ndaemon_auto_start = true\r\ndefault_mode_request_user_input = false\r\nprevent_idle_sleep = false\r\nkeep = true\r\n'
      persist('.codex/config.toml', source)
      const manager = fixture()
      expect((await manager.status('codex')).codex).toMatchObject({
        sandboxMode: 'read-only',
        approvalsReviewer: 'user',
        webSearch: 'cached',
        reasoningEffort: 'low',
        daemonAutoStart: true,
        defaultModeRequestUserInput: false,
        preventIdleSleep: false,
      })
      const configured = await manager.setup(
        await input(manager, 'codex', { codex }),
      )
      expect(configured.status.codex).toEqual(codex)
      const rendered = read('.codex/config.toml')
      expect(rendered).toContain('# keep effort comment')
      expect(readTomlConfig(rendered)).toMatchObject({
        sandbox_mode: codex.sandboxMode,
        approvals_reviewer: codex.approvalsReviewer,
        web_search: codex.webSearch,
        model_reasoning_effort: codex.reasoningEffort,
        features: {
          daemon_auto_start: codex.daemonAutoStart,
          default_mode_request_user_input: codex.defaultModeRequestUserInput,
          prevent_idle_sleep: codex.preventIdleSleep,
          keep: true,
        },
      })
      await manager.setup(await input(manager, 'codex', { codex }))
      expect(read('.codex/config.toml')).toBe(rendered)
      const restored = await manager.restore(
        'codex',
        (await manager.status('codex')).revision,
      )
      expect(restored.codex?.reasoningEffort).toBe('low')
      expect(read('.codex/config.toml')).toBe(source)
    },
  )
  test('preserves unselected and future Codex values while changing one option', async () => {
    persist(
      '.codex/config.toml',
      'sandbox_mode = "future-sandbox"\napprovals_reviewer = "guardian_subagent"\nweb_search = "future-search"\nmodel_reasoning_effort = "future-effort"\n[features]\ndaemon_auto_start = true\ndefault_mode_request_user_input = false\nprevent_idle_sleep = false\n',
    )
    const manager = fixture()
    const configured = await manager.setup(
      await input(manager, 'codex', {
        codex: { webSearch: 'live', preventIdleSleep: true },
      }),
    )
    expect(configured.status.codex).toEqual({
      sandboxMode: 'future-sandbox',
      approvalsReviewer: 'guardian_subagent',
      webSearch: 'live',
      reasoningEffort: 'future-effort',
      daemonAutoStart: true,
      defaultModeRequestUserInput: false,
      preventIdleSleep: true,
    })
  })
  test.each([
    { sandboxMode: 'unrestricted' },
    { approvalsReviewer: 'automatic' },
    { webSearch: 'enabled' },
    { daemonAutoStart: 'false' },
    { defaultModeRequestUserInput: 1 },
    { preventIdleSleep: null },
    { reasoningEffort: '' },
    { reasoningEffort: ' ' },
    { reasoningEffort: 'high\nweb_search = "live"' },
    { unsupportedOption: true },
  ])(
    'rejects invalid Codex selections before modifying files or credentials: %j',
    async (codex) => {
      const source = '# original\nmodel = "old"\n'
      persist('.codex/config.toml', source)
      const manager = fixture()
      const request = await input(manager, 'codex')
      const reply = await clientIntegrationReply(() =>
        manager.setup({
          ...request,
          codex,
        }),
      )
      expect(reply).toEqual({ error: 'invalidInput' })
      expect(read('.codex/config.toml')).toBe(source)
      expect(writeEnvironment).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(directory, 'backups'))).toBe(false)
    },
  )
  test('preserves a custom Codex desktop reasoning effort list', async () => {
    persist(
      '.codex/config.toml',
      '[desktop]\nenabled-reasoning-efforts = ["medium", "max"]\n',
    )
    const manager = fixture()
    await manager.setup(await input(manager, 'codex'))
    expect(readTomlConfig(read('.codex/config.toml')).desktop).toEqual({
      'enabled-reasoning-efforts': ['medium', 'max'],
    })
  })
  test('preserves a previous Codex environment value and refuses to overwrite an external environment change on restore', async () => {
    environment = 'original-user-key'
    const manager = fixture({ platform: 'win32' })
    await manager.setup(await input(manager, 'codex'))
    expect(fs.existsSync(path.join(directory, '.bashrc'))).toBe(false)
    environment = 'external-key'
    await expect(
      manager.restore('codex', (await manager.status('codex')).revision),
    ).rejects.toThrow('conflict')
    environment = gateway.apiKeys[0]
    await manager.restore('codex', (await manager.status('codex')).revision)
    expect(environment).toBe('original-user-key')
  })

  test('rejects conflicting Codex authentication before modifying files or environment', async () => {
    const source =
      '[model_providers.copilot_api.auth]\ncommand = "custom-token-command"\n'
    persist('.codex/config.toml', source)
    const manager = fixture()
    await expect(manager.setup(await input(manager, 'codex'))).rejects.toThrow(
      'invalidConfig',
    )
    expect(read('.codex/config.toml')).toBe(source)
    expect(writeEnvironment).not.toHaveBeenCalled()
    expect((await manager.status('codex')).canRestore).toBe(false)
  })
  test('creates a persistent macOS LaunchAgent and rolls files back if environment setup fails', async () => {
    const manager = fixture({ platform: 'darwin' })
    writeEnvironment.mockRejectedValueOnce(new Error('environmentFailed'))
    await expect(manager.setup(await input(manager, 'codex'))).rejects.toThrow(
      'environmentFailed',
    )
    expect(fs.existsSync(path.join(directory, '.codex/config.toml'))).toBe(
      false,
    )
    expect((await manager.status('codex')).canRestore).toBe(false)
    await manager.setup(await input(manager, 'codex'))
    expect(
      read('Library/LaunchAgents/com.copilot-api.client-env.plist'),
    ).toContain('<key>RunAtLoad</key><true/>')
    writeEnvironment.mockRejectedValueOnce(new Error('environmentFailed'))
    await expect(
      manager.restore('codex', (await manager.status('codex')).revision),
    ).rejects.toThrow('environmentFailed')
    expect((await manager.status('codex')).state).toBe('configured')
  })
  test('installs Claude plugins from GitHub without bundled resources, supports disabling a bridge and reports partial failures', async () => {
    persist(
      '.claude/settings.json',
      '{"enabledPlugins":{"tool-search@copilot-api-marketplace":true,"other@market":true}}',
    )
    const manager = fixture({
      resourceDir: path.join(directory, 'missing-plugin-resources'),
    })
    run.mockImplementation(async (command, args) => {
      expect(command).toBe('claude')
      if (args[1] === 'list') return { stdout: '[]', stderr: '' }
      if (args[1] === 'install')
        persist(
          '.claude/settings.json',
          patchJsonConfig(read('.claude/settings.json'), [
            [['enabledPlugins', args[2]], true],
          ]),
        )
      return { stdout: '', stderr: '' }
    })
    const result = await manager.setup(
      await input(manager, 'claude', {
        plugins: ['agent-inject'],
        nativeToolSearch: true,
      }),
    )
    expect(result.status.plugins).toEqual(['agent-inject'])
    expect(
      readJsonConfig(read('.claude/settings.json')).enabledPlugins,
    ).toMatchObject({
      'tool-search@copilot-api-marketplace': false,
      'other@market': true,
    })
    expect(run.mock.calls[1][1]).toEqual([
      'plugin',
      'marketplace',
      'add',
      'https://github.com/caozhiyuan/copilot-api.git',
      '--scope',
      'user',
    ])
    expect(
      fs.existsSync(path.join(directory, 'backups/claude-marketplace')),
    ).toBe(false)
    expect(run.mock.calls[2][1]).toEqual([
      'plugin',
      'marketplace',
      'update',
      'copilot-api-marketplace',
    ])
    run.mockRejectedValueOnce(new Error('commandMissing'))
    const partial = await manager.setup(
      await input(manager, 'claude', { plugins: ['agent-inject'] }),
    )
    expect(partial.pluginError).toBe('commandMissing')
    expect(partial.status.canRestore).toBe(true)
    await manager.restore('claude', partial.status.revision)
    expect(
      run.mock.calls.some(
        (call) => call[1][1] === 'uninstall' && call[1].includes('--keep-data'),
      ),
    ).toBe(true)
  })

  test('skips Claude plugin reinstallation when the selection is unchanged', async () => {
    persist(
      '.claude/settings.json',
      '{"enabledPlugins":{"agent-inject@copilot-api-marketplace":true}}',
    )
    const manager = fixture()
    run.mockImplementation((_command, args) =>
      Promise.resolve({
        stdout:
          args[1] === 'list' ?
            JSON.stringify([
              {
                id: 'agent-inject@copilot-api-marketplace',
                scope: 'user',
                enabled: true,
              },
            ])
          : '',
        stderr: '',
      }),
    )
    const result = await manager.setup(
      await input(manager, 'claude', { plugins: ['agent-inject'] }),
    )
    expect(result.pluginError).toBeUndefined()
    expect(result.status.plugins).toEqual(['agent-inject'])
    expect(run.mock.calls.map((call) => call[1][1])).toEqual(['list'])
  })

  test('saves native Tool Search and the tool-search plugin enabled together', async () => {
    const manager = fixture()
    run.mockImplementation((_command, args) => {
      if (args[1] === 'install')
        persist(
          '.claude/settings.json',
          patchJsonConfig(read('.claude/settings.json'), [
            [['enabledPlugins', args[2]], true],
          ]),
        )
      return Promise.resolve({
        stdout: args[1] === 'list' ? '[]' : '',
        stderr: '',
      })
    })
    const result = await manager.setup(
      await input(manager, 'claude', {
        nativeToolSearch: true,
        plugins: ['tool-search'],
      }),
    )
    expect(result.pluginError).toBeUndefined()
    expect(result.status.nativeToolSearch).toBe(true)
    expect(result.status.plugins).toEqual(['tool-search'])
    expect(readJsonConfig(read('.claude/settings.json'))).toMatchObject({
      env: { ENABLE_TOOL_SEARCH: 'true' },
      enabledPlugins: { 'tool-search@copilot-api-marketplace': true },
    })
  })

  test('returns the failed plugin command and exit code while retaining the saved configuration', async () => {
    const manager = fixture()
    run.mockRejectedValueOnce(
      new ClientCommandError('claude', ['plugin', 'list', '--json'], {
        code: 1,
        stderr: 'private token',
      }),
    )
    const result = await manager.setup(
      await input(manager, 'claude', { plugins: ['agent-inject'] }),
    )
    expect(result.pluginError).toBe('commandFailed')
    expect(result.pluginFailure).toEqual({
      command: 'claude plugin list --json',
      exitCode: '1',
    })
    expect(result.status.canRestore).toBe(true)
    expect(result.status.state).toBe('configured')
    expect(JSON.stringify(result)).not.toContain('private token')
  })

  test('updates and enables existing Claude plugins without uninstalling them on restore', async () => {
    const manager = fixture()
    run.mockImplementation((_command, args) =>
      Promise.resolve({
        stdout:
          args[1] === 'list' ?
            JSON.stringify([
              {
                id: 'agent-inject@copilot-api-marketplace',
                scope: 'user',
                enabled: false,
              },
            ])
          : '',
        stderr: '',
      }),
    )
    await manager.setup(
      await input(manager, 'claude', { plugins: ['agent-inject'] }),
    )
    expect(run.mock.calls.some((call) => call[1][1] === 'update')).toBe(true)
    expect(run.mock.calls.some((call) => call[1][1] === 'enable')).toBe(true)
    await manager.restore('claude', (await manager.status('claude')).revision)
    expect(run.mock.calls.some((call) => call[1][1] === 'uninstall')).toBe(
      false,
    )
  })

  test.each([
    { error: new Error('commandMissing'), code: 'commandMissing' },
    {
      error: new ClientCommandError(
        'claude',
        [
          'plugin',
          'uninstall',
          'agent-inject@copilot-api-marketplace',
          '--scope',
          'user',
          '--keep-data',
        ],
        { code: 1, stderr: 'private CLI output' },
      ),
      code: 'commandFailed',
    },
    { error: new Error('private CLI output'), code: 'operationFailed' },
  ])(
    'restores Claude files and keys after an uninstall error: $code',
    async ({ error, code }) => {
      const source =
        '{\n // original settings\n "env":{"ANTHROPIC_AUTH_TOKEN":"original-key"}, "permissions":{"deny":["Read(.env)"]}\n}\n'
      persist('.claude/settings.json', source)
      const manager = fixture()
      run.mockImplementation(async (_command, args) => {
        if (args[1] === 'install')
          persist(
            '.claude/settings.json',
            patchJsonConfig(read('.claude/settings.json'), [
              [['enabledPlugins', args[2]], true],
            ]),
          )
        return { stdout: args[1] === 'list' ? '[]' : '', stderr: '' }
      })
      const configured = await manager.setup(
        await input(manager, 'claude', {
          plugins: ['agent-inject', 'tool-search'],
        }),
      )
      run.mockClear()
      run.mockImplementation(async (_command, args) => {
        if (args[2] === 'agent-inject@copilot-api-marketplace') throw error
        persist(
          '.claude/settings.json',
          patchJsonConfig(read('.claude/settings.json'), [
            [['enabledPlugins', args[2]], undefined],
          ]),
        )
        return { stdout: '', stderr: '' }
      })

      const reply = await clientIntegrationReply(() =>
        manager.restore('claude', configured.status.revision),
      )
      expect(reply).toMatchObject({
        data: { client: 'claude', canRestore: false, pluginError: code },
      })
      if (error instanceof ClientCommandError)
        expect(reply).toMatchObject({ data: { pluginFailure: error.details } })
      else expect(reply).not.toHaveProperty('data.pluginFailure')
      expect(JSON.stringify(reply)).not.toContain('private CLI output')
      expect(read('.claude/settings.json')).toBe(source)
      expect(fs.existsSync(path.join(directory, 'backups/claude.json'))).toBe(
        false,
      )
      expect(run.mock.calls.map((call) => call[1])).toEqual([
        [
          'plugin',
          'uninstall',
          'agent-inject@copilot-api-marketplace',
          '--scope',
          'user',
          '--keep-data',
        ],
        [
          'plugin',
          'uninstall',
          'tool-search@copilot-api-marketplace',
          '--scope',
          'user',
          '--keep-data',
        ],
      ])
    },
  )

  test('removes newly created Claude settings even when every plugin uninstall fails', async () => {
    const manager = fixture()
    run.mockImplementation(async (_command, args) => ({
      stdout: args[1] === 'list' ? '[]' : '',
      stderr: '',
    }))
    const configured = await manager.setup(
      await input(manager, 'claude', {
        plugins: ['agent-inject', 'tool-search'],
      }),
    )
    run.mockClear()
    run.mockRejectedValue(new Error('commandMissing'))

    expect(
      await manager.restore('claude', configured.status.revision),
    ).toMatchObject({
      canRestore: false,
      pluginError: 'commandMissing',
    })
    expect(run).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(path.join(directory, '.claude/settings.json'))).toBe(
      false,
    )
    expect(fs.existsSync(path.join(directory, 'backups/claude.json'))).toBe(
      false,
    )
  })

  test('configures Harness env, installs its plugin and restores the first backup', async () => {
    persist('.dsh/profiles/web.yaml', '# profile')
    persist('.dsh/profiles/desktop/config.yaml', '# profile')
    const manager = fixture()
    expect((await manager.getState()).harnessProfiles).toEqual([
      'desktop',
      'web',
    ])
    const source = '# keep\nOTHER=unchanged\nGITHUB_COPILOT_API_KEY=old\n'
    persist('.dsh/.env', source)
    const result = await manager.setup(
      await input(manager, 'harness', { profile: 'desktop', model: '' }),
    )
    expect(parseEnv(read('.dsh/.env'))).toMatchObject({
      COPILOT_API_BASE_URL: gateway.baseUrl,
      GITHUB_COPILOT_API_KEY: gateway.apiKeys[0],
      OTHER: 'unchanged',
    })
    expect(read('.dsh/.env')).toStartWith(source)
    expect(result.status.state).toBe('configured')
    expect(run).toHaveBeenCalledWith('dsh', [
      'plugin',
      '--profile',
      'desktop',
      'add',
      'dsh-copilot-api',
    ])
    await expect(
      manager.setup(
        await input(manager, 'harness', { profile: '../../profile' }),
      ),
    ).rejects.toThrow('invalidInput')
    expect(read('.dsh/profiles/web.yaml')).toBe('# profile')
    run.mockRejectedValueOnce(new Error('commandMissing'))
    const retried = await manager.setup(await input(manager, 'harness'))
    expect(retried.pluginError).toBe('commandMissing')
    expect(retried.status.canRestore).toBe(true)
    await manager.restore('harness', retried.status.revision)
    expect(read('.dsh/.env')).toBe(source)
    expect(
      await clientIntegrationReply(() => {
        throw new Error('secret-key-in-command-output')
      }),
    ).toEqual({ error: 'operationFailed' })
    expect(await clientIntegrationReply(() => 42)).toEqual({ data: 42 })
    await expect(
      manager.restore('opencode', (await manager.status('opencode')).revision),
    ).rejects.toThrow('noBackup')
  })
  test('uses DSH_HOME for Harness env and profile detection without changing profile YAML', async () => {
    for (const configured of [
      path.join(directory, 'harness-custom'),
      '~/harness-tilde',
      '~',
    ]) {
      const root =
        configured === '~' ? directory
        : configured.startsWith('~/') ?
          path.join(directory, configured.slice(2))
        : configured
      const manager = fixture({ env: { DSH_HOME: configured } })
      const result = await manager.setup(
        await input(manager, 'harness', { model: '' }),
      )
      expect(result.status.configPath).toBe(path.join(root, '.env'))
      expect(
        parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'))
          .GITHUB_COPILOT_API_KEY,
      ).toBe(gateway.apiKeys[0])
      await manager.restore('harness', result.status.revision)
      expect(fs.existsSync(path.join(root, '.env'))).toBe(false)
    }
  })
  test('fetches each client catalog with the right user agent and gateway authentication', async () => {
    const fetchModels = mock((_url: unknown, options?: RequestInit) =>
      Promise.resolve(
        Response.json(
          (
            String(recordHeaders(options).get('user-agent')).startsWith(
              'claude',
            )
          ) ?
            { data: [{ id: 'my-claude-gpt[1m]', display_name: 'GPT (codex)' }] }
          : {
              models: [
                { slug: 'codex/gpt', display_name: 'GPT (codex)' },
                { slug: 'codex/gpt' },
                {},
              ],
            },
        ),
      ),
    )
    const manager = fixture({ fetch: fetchModels as unknown as typeof fetch })
    expect(await manager.getModels('claude')).toEqual([
      { id: 'my-claude-gpt[1m]', name: 'GPT (codex)' },
    ])
    expect(await manager.getModels('codex')).toHaveLength(1)
    expect(fetchModels.mock.calls[0][0]).toBe(`${gateway.baseUrl}/v1/models`)
    expect(recordHeaders(fetchModels.mock.calls[0][1]).get('x-api-key')).toBe(
      'test-gateway-key',
    )
    fetchModels.mockImplementation(() =>
      Promise.resolve(new Response('', { status: 503 })),
    )
    await expect(manager.getModels('claude')).rejects.toThrow('modelsFailed')
    fetchModels.mockImplementation(() =>
      Promise.resolve(Response.json({ bad: [] })),
    )
    await expect(manager.getModels('codex')).rejects.toThrow('modelsFailed')
  })
  test('keeps model-specific Codex reasoning levels and filters malformed catalog values', async () => {
    const manager = fixture({
      fetch: Object.assign(
        mock(() =>
          Promise.resolve(
            Response.json({
              models: [
                {
                  slug: 'codex/limited',
                  display_name: 'Limited',
                  supported_reasoning_levels: [
                    { effort: 'high' },
                    { effort: 'low' },
                    { effort: 'high' },
                    { effort: 'future-effort' },
                    { effort: '' },
                    { effort: ' ' },
                    { effort: 'high\nunsafe' },
                    { effort: 2 },
                    {},
                    null,
                  ],
                },
                {
                  slug: 'codex/no-levels',
                  supported_reasoning_levels: 'invalid',
                },
                { slug: 'codex/empty', supported_reasoning_levels: [] },
                { supported_reasoning_levels: [{ effort: 'low' }] },
              ],
            }),
          ),
        ),
        { preconnect: originalFetch.preconnect },
      ),
    })
    expect(await manager.getModels('codex')).toEqual([
      {
        id: 'codex/limited',
        name: 'Limited',
        reasoningEfforts: ['high', 'low', 'future-effort'],
      },
      { id: 'codex/no-levels', name: 'codex/no-levels' },
      { id: 'codex/empty', name: 'codex/empty' },
    ])
  })
})
function recordHeaders(options?: RequestInit) {
  return new Headers(options?.headers)
}
