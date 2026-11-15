import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { parseEnv } from 'node:util'
import { writeFileAtomically } from '../../src/lib/atomic-file'
import {
  isObject,
  patchJsonConfig,
  patchEnvConfig,
  patchTomlConfig,
  readJsonConfig,
  readTomlConfig,
} from './client-config'
import { ClientCommandError, runClientCommand } from './client-command'
import { formatCodexConfig } from './codex-config'
import {
  CLIENT_KEY_ENV,
  macEnvironmentAgent,
  patchShellEnvironment,
  readClientEnvironment,
  writeClientEnvironment,
} from './client-environment'
import {
  CLIENT_ERROR_CODES,
  CODEX_APPROVAL_REVIEWERS,
  CODEX_CLIENT_DEFAULTS,
  CODEX_SANDBOX_MODES,
  CODEX_WEB_SEARCH_MODES,
  type ClientId,
  type ClientIntegrationStatus,
  type ClientModelOption,
  type ClientPlugin,
  type ClientRestoreResult,
  type ClientSetupInput,
  type ClientSetupResult,
} from '../shared/client-integrations'

const clientSchema = z.enum(['claude', 'opencode', 'codex', 'harness'])
const agentSchema = clientSchema.optional()
const modelSchema = z
  .string()
  .max(500)
  .regex(/^[^\r\n\0]*$/)
const reasoningEffortSchema = modelSchema.trim().min(1)
const setupSchema = z
  .object({
    client: clientSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    apiKey: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[^\r\n\0]+$/),
    profile: z
      .string()
      .regex(/^[\w-]{1,80}$/)
      .default('web'),
    model: modelSchema,
    fableModel: modelSchema,
    opusModel: modelSchema,
    sonnetModel: modelSchema,
    smallModel: modelSchema,
    reviewModel: modelSchema,
    nativeToolSearch: z.boolean(),
    agentContext: z.boolean(),
    plugins: z.array(z.enum(['agent-inject', 'tool-search'])),
    codex: z
      .object({
        sandboxMode: z.enum(CODEX_SANDBOX_MODES).optional(),
        approvalsReviewer: z.enum(CODEX_APPROVAL_REVIEWERS).optional(),
        webSearch: z.enum(CODEX_WEB_SEARCH_MODES).optional(),
        reasoningEffort: reasoningEffortSchema.optional(),
        daemonAutoStart: z.boolean().optional(),
        defaultModeRequestUserInput: z.boolean().optional(),
        preventIdleSleep: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
const backupSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      before: z.string().nullable(),
      applied: z.string(),
    }),
  ),
  environment: z
    .object({ before: z.string().nullable(), applied: z.string() })
    .optional(),
  plugins: z.array(z.enum(['agent-inject', 'tool-search'])).optional(),
})
type Backup = z.infer<typeof backupSchema>
type Snapshot = Map<string, string | null>
const hash = (value: string | null) =>
  createHash('sha256')
    .update(value === null ? '\0missing' : '\0file' + value)
    .digest('hex')
const record = (value: unknown) => (isObject(value) ? value : {})
const string = (value: unknown) => (typeof value === 'string' ? value : '')
const PLUGINS: ClientPlugin[] = ['agent-inject', 'tool-search']
const samePlugins = (left: ClientPlugin[], right: ClientPlugin[]) => {
  const normalize = (plugins: ClientPlugin[]) => [...new Set(plugins)].sort()
  const current = normalize(left)
  const previous = normalize(right)
  return (
    current.length === previous.length
    && current.every((plugin, index) => plugin === previous[index])
  )
}
const CLAUDE_ENV_DEFAULTS = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
  CLAUDE_CODE_AUTO_MODE_SERVER: '0',
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: 'true',
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
  CLAUDE_CODE_EFFORT_LEVEL: 'max',
  MCP_CONNECT_TIMEOUT_MS: '20000',
}
type CodexDefault = string | number | boolean | string[]
const CODEX_DEFAULTS: Array<[string[], CodexDefault]> = [
  [['model_reasoning_effort'], CODEX_CLIENT_DEFAULTS.reasoningEffort],
  [['model_reasoning_summary'], 'auto'],
  [['plan_mode_reasoning_effort'], 'max'],
  [['model_context_window'], 400000],
  [['sandbox_mode'], CODEX_CLIENT_DEFAULTS.sandboxMode],
  [['approvals_reviewer'], CODEX_CLIENT_DEFAULTS.approvalsReviewer],
  [['suppress_unstable_features_warning'], true],
  [['web_search'], CODEX_CLIENT_DEFAULTS.webSearch],
  [['service_tier'], 'default'],
  [['model_providers', 'copilot_api', 'supports_standalone_web_search'], true],
  [['model_providers', 'copilot_api', 'request_max_retries'], 3],
  [['model_providers', 'copilot_api', 'stream_max_retries'], 3],
  [['model_providers', 'copilot_api', 'stream_idle_timeout_ms'], 300000],
  [['features', 'remote_compaction_v2'], true],
  [['features', 'api_key_model_discovery'], true],
  [
    ['features', 'default_mode_request_user_input'],
    CODEX_CLIENT_DEFAULTS.defaultModeRequestUserInput,
  ],
  [['features', 'standalone_web_search'], true],
  [['features', 'daemon_auto_start'], CODEX_CLIENT_DEFAULTS.daemonAutoStart],
  [['features', 'prevent_idle_sleep'], CODEX_CLIENT_DEFAULTS.preventIdleSleep],
  [['features', 'defer_mailbox_preemption'], true],
  [['features', 'instant_interrupt'], false],
  [
    ['desktop', 'enabled-reasoning-efforts'],
    ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'],
  ],
  [['analytics', 'enabled'], false],
]
const PROVIDER_WRAPPER = `import provider from '../copilot-api/provider.js'
import { readFileSync } from 'node:fs'

export default {
  ...provider,
  setup(ctx) {
    const options = JSON.parse(readFileSync(new URL('../copilot-api/settings.json', import.meta.url), 'utf8'))
    return provider.setup({ ...ctx, options: { ...ctx.options, ...options } })
  },
}
`

export interface ClientIntegrationOptions {
  dataDir: string
  resourceDir: string
  getGateway: () => Promise<{ baseUrl: string; apiKeys: string[] }>
  homeDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  runCommand?: typeof runClientCommand
  readEnvironment?: () => Promise<string | null>
  writeEnvironment?: (value: string | null) => Promise<void>
  fetch?: typeof fetch
}

function readFile(file: string): string | null {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('symlinkConfig')
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function createClientIntegrations(options: ClientIntegrationOptions) {
  const home = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const configHome = (value: string | undefined, fallback: string) =>
    value && path.isAbsolute(value) ? value : fallback
  const claudeDir = configHome(
    env.CLAUDE_CONFIG_DIR,
    path.join(home, '.claude'),
  )
  const codexDir = configHome(env.CODEX_HOME, path.join(home, '.codex'))
  const configuredHarnessHome = env.DSH_HOME
  const harnessHome =
    !configuredHarnessHome?.trim() ? path.join(home, '.dsh')
    : configuredHarnessHome === '~' ? home
    : (
      configuredHarnessHome.startsWith('~/')
      || configuredHarnessHome.startsWith('~\\')
    ) ?
      path.join(home, configuredHarnessHome.slice(2))
    : path.resolve(configuredHarnessHome)
  const opencodeDir = path.join(
    configHome(env.XDG_CONFIG_HOME, path.join(home, '.config')),
    'opencode',
  )
  const configPaths: Record<ClientId, string> = {
    claude: path.join(claudeDir, 'settings.json'),
    codex: path.join(codexDir, 'config.toml'),
    opencode: path.join(opencodeDir, 'copilot-api', 'settings.json'),
    harness: path.join(harnessHome, '.env'),
  }
  const providerFile = path.join(
    opencodeDir,
    'plugins',
    'copilot-api-provider.js',
  )
  const providerSource = path.join(opencodeDir, 'copilot-api', 'provider.js')
  const agentFile = path.join(opencodeDir, 'plugins', 'agent-context.js')
  const environmentFiles =
    platform === 'darwin' ?
      [
        path.join(
          home,
          'Library',
          'LaunchAgents',
          'com.copilot-api.client-env.plist',
        ),
      ]
    : platform === 'win32' ? []
    : ['.profile', '.bashrc', '.zshenv'].map((name) => path.join(home, name))
  const files: Record<ClientId, string[]> = {
    claude: [configPaths.claude],
    opencode: [configPaths.opencode, providerFile, providerSource, agentFile],
    codex: [configPaths.codex, ...environmentFiles],
    harness: [configPaths.harness],
  }
  const readEnvironment =
    options.readEnvironment ?? (() => readClientEnvironment(platform))
  const writeEnvironment =
    options.writeEnvironment
    ?? ((value) => writeClientEnvironment(value, platform))
  const run = options.runCommand ?? runClientCommand
  const asset = (relative: string) =>
    fs.readFileSync(path.join(options.resourceDir, relative), 'utf8')
  const backupPath = (client: ClientId) =>
    path.join(options.dataDir, `${client}.json`)
  const backup = (client: ClientId): Backup | undefined => {
    const content = readFile(backupPath(client))
    if (content === null) return undefined
    const parsed = backupSchema.parse(JSON.parse(content))
    if (parsed.files.some((file) => !files[client].includes(file.path)))
      throw new Error('invalidConfig')
    return parsed
  }
  const snapshot = (client: ClientId): Snapshot =>
    new Map(files[client].map((file) => [file, readFile(file)]))
  const revision = (
    current: Snapshot,
    environment: string | null,
    saved: Backup | undefined,
  ) => hash(JSON.stringify([[...current], environment, saved]))
  const isKeyValid = (key: string, apiKeys: string[]) =>
    apiKeys.length ? apiKeys.includes(key) : key === 'dummy'

  async function status(client: ClientId): Promise<ClientIntegrationStatus> {
    let current = new Map<string, string | null>()
    let saved: Backup | undefined
    let environment: string | null = null
    const result: ClientIntegrationStatus = {
      client,
      configPath: configPaths[client],
      revision: '',
      state: 'unconfigured',
      canRestore: false,
      model: '',
      fableModel: '',
      opusModel: '',
      sonnetModel: '',
      smallModel: '',
      reviewModel: '',
      nativeToolSearch: false,
      agentContext: false,
      plugins: [],
    }
    try {
      current = snapshot(client)
      saved = backup(client)
      result.canRestore = saved !== undefined
      if (client === 'codex') environment = await readEnvironment()
      const { baseUrl, apiKeys } = await options.getGateway()
      const content = current.get(configPaths[client]) ?? ''
      const config =
        client === 'codex' ? readTomlConfig(content)
        : client === 'harness' ? parseEnv(content)
        : readJsonConfig(content)
      let configured = false
      if (client === 'claude') {
        const settings = record(config.env)
        result.model = string(config.model)
        result.fableModel = string(settings.ANTHROPIC_DEFAULT_FABLE_MODEL)
        result.opusModel = string(settings.ANTHROPIC_DEFAULT_OPUS_MODEL)
        result.sonnetModel = string(settings.ANTHROPIC_DEFAULT_SONNET_MODEL)
        result.smallModel = string(settings.ANTHROPIC_DEFAULT_HAIKU_MODEL)
        result.reviewModel = string(settings.CLAUDE_CODE_AUTO_MODE_MODEL)
        result.nativeToolSearch = settings.ENABLE_TOOL_SEARCH === 'true'
        result.plugins = PLUGINS.filter(
          (plugin) =>
            record(config.enabledPlugins)[`${plugin}@copilot-api-marketplace`]
            === true,
        )
        configured =
          settings.ANTHROPIC_BASE_URL === baseUrl
          && isKeyValid(string(settings.ANTHROPIC_AUTH_TOKEN), apiKeys)
          && !!result.model
      } else if (client === 'codex') {
        result.model = string(config.model)
        const option = (value: unknown, fallback: string) =>
          string(value).trim() ? string(value) : fallback
        const feature = (key: string, fallback: boolean) => {
          const value = record(config.features)[key]
          return typeof value === 'boolean' ? value : fallback
        }
        result.codex = {
          sandboxMode: option(
            config.sandbox_mode,
            CODEX_CLIENT_DEFAULTS.sandboxMode,
          ),
          approvalsReviewer: option(
            config.approvals_reviewer,
            CODEX_CLIENT_DEFAULTS.approvalsReviewer,
          ),
          webSearch: option(config.web_search, CODEX_CLIENT_DEFAULTS.webSearch),
          reasoningEffort: string(config.model_reasoning_effort).trim(),
          daemonAutoStart: feature(
            'daemon_auto_start',
            CODEX_CLIENT_DEFAULTS.daemonAutoStart,
          ),
          defaultModeRequestUserInput: feature(
            'default_mode_request_user_input',
            CODEX_CLIENT_DEFAULTS.defaultModeRequestUserInput,
          ),
          preventIdleSleep: feature(
            'prevent_idle_sleep',
            CODEX_CLIENT_DEFAULTS.preventIdleSleep,
          ),
        }
        const provider = record(record(config.model_providers).copilot_api)
        configured =
          config.model_provider === 'copilot_api'
          && provider.base_url === baseUrl
          && provider.model_catalog_url === `${baseUrl}/models`
          && provider.env_key === CLIENT_KEY_ENV
          && isKeyValid(environment ?? '', apiKeys)
          && !!result.model
      } else if (client === 'opencode') {
        result.agentContext = current.get(agentFile) !== null
        configured =
          config.baseURL === `${baseUrl}/v1`
          && isKeyValid(string(config.apiKey), apiKeys)
          && current.get(providerFile) === PROVIDER_WRAPPER
          && current.get(providerSource)
            === asset('plugin/opencode/copilot-api-provider.js')
        if (
          result.agentContext
          && current.get(agentFile)
            !== asset('plugin/opencode/agent-context.js')
        )
          configured = false
      } else {
        configured =
          config.COPILOT_API_BASE_URL === baseUrl
          && isKeyValid(string(config[CLIENT_KEY_ENV]), apiKeys)
      }
      const changed = saved?.files.some(
        (file) => hash(current.get(file.path) ?? null) !== file.applied,
      )
      result.state =
        configured && !changed ? 'configured'
        : saved || content ? 'outdated'
        : 'unconfigured'
    } catch (error) {
      result.state = 'error'
      result.error = errorCode(error)
    }
    result.revision = revision(current, environment, saved)
    return result
  }

  // One queue for config, environment, restore, and CLI operations. A rejected
  // operation must not prevent subsequent operations from using the queue.
  let pending = Promise.resolve()
  function transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation)
    pending = result.then(
      () => {},
      () => {},
    )
    return result
  }

  function desired(
    input: ClientSetupInput,
    current: Snapshot,
    baseUrl: string,
  ): Snapshot {
    const changes: Snapshot = new Map()
    const content = current.get(configPaths[input.client]) ?? ''
    if (input.client === 'claude') {
      const main = input.model.trim()
      const small = input.smallModel.trim() || main
      const config = readJsonConfig(content)
      const environment = record(config.env)
      changes.set(
        configPaths.claude,
        patchJsonConfig(content, [
          [['model'], main],
          [['env', 'ANTHROPIC_BASE_URL'], baseUrl],
          [['env', 'ANTHROPIC_AUTH_TOKEN'], input.apiKey],
          [['env', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'], '1'],
          [
            ['env', 'ANTHROPIC_DEFAULT_FABLE_MODEL'],
            input.fableModel.trim() || main,
          ],
          [
            ['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
            input.opusModel.trim() || main,
          ],
          [
            ['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
            input.sonnetModel.trim() || main,
          ],
          [['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], small],
          [
            ['env', 'CLAUDE_CODE_AUTO_MODE_MODEL'],
            input.reviewModel.trim() || undefined,
          ],
          [
            ['env', 'ENABLE_TOOL_SEARCH'],
            input.nativeToolSearch ? 'true' : 'false',
          ],
          [['env', 'ANTHROPIC_MODEL'], undefined],
          [['env', 'CLAUDE_CODE_USE_VERTEX'], '0'],
          [['env', 'CLAUDE_CODE_USE_BEDROCK'], '0'],
          [['env', 'CLAUDE_CODE_USE_FOUNDRY'], '0'],
          ...Object.entries(CLAUDE_ENV_DEFAULTS)
            .filter(([key]) => environment[key] === undefined)
            .map(([key, value]): [string[], unknown] => [['env', key], value]),
          ...PLUGINS.filter(
            (plugin) =>
              !input.plugins.includes(plugin)
              && record(config.enabledPlugins)[
                `${plugin}@copilot-api-marketplace`
              ] !== undefined,
          ).map((plugin): [string[], unknown] => [
            ['enabledPlugins', `${plugin}@copilot-api-marketplace`],
            false,
          ]),
        ]),
      )
    } else if (input.client === 'codex') {
      const provider = ['model_providers', 'copilot_api']
      const config = readTomlConfig(content)
      const existing = record(record(config.model_providers).copilot_api)
      if (
        existing.auth !== undefined
        || existing.experimental_bearer_token !== undefined
      )
        throw new Error('invalidConfig')
      const codexChanges: Array<[string[], CodexDefault | undefined]> = [
        [['sandbox_mode'], input.codex?.sandboxMode],
        [['approvals_reviewer'], input.codex?.approvalsReviewer],
        [['web_search'], input.codex?.webSearch],
        [['model_reasoning_effort'], input.codex?.reasoningEffort],
        [['features', 'daemon_auto_start'], input.codex?.daemonAutoStart],
        [
          ['features', 'default_mode_request_user_input'],
          input.codex?.defaultModeRequestUserInput,
        ],
        [['features', 'prevent_idle_sleep'], input.codex?.preventIdleSleep],
      ]
      changes.set(
        configPaths.codex,
        formatCodexConfig(
          patchTomlConfig(content, [
            [['model'], input.model.trim()],
            [['model_provider'], 'copilot_api'],
            [[...provider, 'name'], 'OpenAI'],
            [[...provider, 'base_url'], baseUrl],
            [[...provider, 'model_catalog_url'], `${baseUrl}/models`],
            [[...provider, 'env_key'], CLIENT_KEY_ENV],
            [[...provider, 'requires_openai_auth'], true],
            [[...provider, 'wire_api'], 'responses'],
            [[...provider, 'supports_websockets'], false],
            ...CODEX_DEFAULTS.filter(([keys]) => {
              const value = keys.reduce<unknown>(
                (current, key) => record(current)[key],
                config,
              )
              return (
                value === undefined
                || (typeof value === 'string' && !value.trim())
                || (Array.isArray(value) && value.length === 0)
              )
            }),
            ...codexChanges.filter(
              (entry): entry is [string[], CodexDefault] =>
                entry[1] !== undefined,
            ),
          ]),
        ),
      )
      for (const file of environmentFiles)
        changes.set(
          file,
          platform === 'darwin' ?
            macEnvironmentAgent(input.apiKey)
          : patchShellEnvironment(current.get(file) ?? '', input.apiKey),
        )
    } else if (input.client === 'harness') {
      changes.set(
        configPaths.harness,
        patchEnvConfig(content, {
          COPILOT_API_BASE_URL: baseUrl,
          [CLIENT_KEY_ENV]: input.apiKey,
        }),
      )
    } else {
      changes.set(
        configPaths.opencode,
        JSON.stringify(
          { baseURL: `${baseUrl}/v1`, apiKey: input.apiKey },
          null,
          2,
        ) + '\n',
      )
      changes.set(providerFile, PROVIDER_WRAPPER)
      changes.set(
        providerSource,
        asset('plugin/opencode/copilot-api-provider.js'),
      )
      if (input.agentContext)
        changes.set(agentFile, asset('plugin/opencode/agent-context.js'))
      else if (current.get(agentFile) !== null) changes.set(agentFile, null)
    }
    return changes
  }

  function writeSnapshot(changes: Snapshot) {
    for (const [file, content] of changes) {
      if (readFile(file) === content) continue
      if (content === null) fs.rmSync(file, { force: true })
      else writeFileAtomically(file, content)
    }
  }

  async function installClaudePlugins(
    plugins: ClientPlugin[],
    previousPlugins: ClientPlugin[],
    saved: Backup,
  ) {
    if (!plugins.length) return
    // One list call still detects plugins removed or disabled outside the app.
    const listed = await run('claude', ['plugin', 'list', '--json'])
    const installed: unknown = JSON.parse(listed.stdout)
    if (!Array.isArray(installed)) throw new Error('commandFailed')
    const installedFor = (plugin: ClientPlugin) =>
      installed.find(
        (item: unknown) =>
          record(item).id === `${plugin}@copilot-api-marketplace`
          && record(item).scope === 'user',
      ) as unknown
    if (
      samePlugins(plugins, previousPlugins)
      && plugins.every(
        (plugin) => record(installedFor(plugin)).enabled === true,
      )
    )
      return
    await run('claude', [
      'plugin',
      'marketplace',
      'add',
      'https://github.com/caozhiyuan/copilot-api.git',
      '--scope',
      'user',
    ])
    await run('claude', [
      'plugin',
      'marketplace',
      'update',
      'copilot-api-marketplace',
    ])
    for (const plugin of plugins) {
      const existing = installedFor(plugin)
      const existed = existing !== undefined
      await run('claude', [
        'plugin',
        existed ? 'update' : 'install',
        `${plugin}@copilot-api-marketplace`,
        '--scope',
        'user',
      ])
      if (existed && record(existing).enabled !== true)
        await run('claude', [
          'plugin',
          'enable',
          `${plugin}@copilot-api-marketplace`,
          '--scope',
          'user',
        ])
      if (!existed && !saved.plugins?.includes(plugin))
        saved.plugins = [...(saved.plugins ?? []), plugin]
      for (const file of saved.files) file.applied = hash(readFile(file.path))
      writeFileAtomically(backupPath('claude'), JSON.stringify(saved))
    }
  }

  return {
    status,
    async getState(agentInput?: unknown) {
      const selection = agentSchema.safeParse(agentInput)
      if (!selection.success) throw new Error('invalidInput')
      const agent = selection.data
      const gateway = await options.getGateway()
      let harnessProfiles: string[] = []
      if (!agent || agent === 'harness') {
        try {
          harnessProfiles = fs
            .readdirSync(path.join(harnessHome, 'profiles'))
            .map((name) => name.replace(/\.ya?ml$/i, ''))
            .filter((name) => /^[\w-]+$/.test(name))
        } catch {
          /* Harness may not be installed. */
        }
      }
      const selectedClients: ClientId[] =
        agent ? [agent] : ['claude', 'opencode', 'codex']
      return {
        ...gateway,
        clients: await Promise.all(selectedClients.map(status)),
        harnessProfiles: [...new Set(harnessProfiles)].sort(),
      }
    },
    async getModels(clientInput: unknown): Promise<ClientModelOption[]> {
      const client = z.enum(['claude', 'codex']).parse(clientInput)
      const { baseUrl, apiKeys } = await options.getGateway()
      const response = await (options.fetch ?? fetch)(`${baseUrl}/v1/models`, {
        headers: {
          'x-api-key': apiKeys[0] ?? 'dummy',
          'user-agent':
            client === 'claude' ?
              'claude-code/copilot-api-desktop'
            : 'codex-cli/0.160.0 (copilot-api-desktop)',
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error('modelsFailed')
      const body = record(await response.json())
      const models = client === 'codex' ? body.models : body.data
      if (!Array.isArray(models)) throw new Error('modelsFailed')
      return [
        ...new Map(
          models.flatMap((item: unknown) => {
            const model = record(item)
            const id = string(client === 'codex' ? model.slug : model.id)
            const reasoningEfforts =
              (
                client === 'codex'
                && Array.isArray(model.supported_reasoning_levels)
              ) ?
                [
                  ...new Set(
                    model.supported_reasoning_levels.flatMap(
                      (level: unknown) => {
                        const effort = reasoningEffortSchema.safeParse(
                          record(level).effort,
                        )
                        return effort.success ? [effort.data] : []
                      },
                    ),
                  ),
                ]
              : []
            return id ?
                [
                  [
                    id,
                    {
                      id,
                      name: string(model.display_name) || id,
                      ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
                    },
                  ] as const,
                ]
              : []
          }),
        ).values(),
      ]
    },
    setup(input: unknown): Promise<ClientSetupResult> {
      return transaction(async () => {
        const parsed = setupSchema.safeParse(input)
        if (!parsed.success) throw new Error('invalidInput')
        const data = parsed.data
        if (
          (data.client === 'claude' || data.client === 'codex')
          && !data.model.trim()
        )
          throw new Error('invalidInput')
        const beforeStatus = await status(data.client)
        if (beforeStatus.state === 'error') throw new Error(beforeStatus.error)
        if (beforeStatus.revision !== data.revision) throw new Error('conflict')
        const gateway = await options.getGateway()
        if (!isKeyValid(data.apiKey, gateway.apiKeys))
          throw new Error('invalidKey')
        const current = snapshot(data.client)
        const saved = backup(data.client)
        const environment =
          data.client === 'codex' ? await readEnvironment() : null
        if (revision(current, environment, saved) !== data.revision)
          throw new Error('conflict')
        const changes = desired(data, current, gateway.baseUrl)
        const next: Backup = {
          files: saved?.files.map((file) => ({ ...file })) ?? [],
          ...(saved?.plugins ? { plugins: [...saved.plugins] } : {}),
        }
        for (const [file] of changes)
          if (!next.files.some((entry) => entry.path === file))
            next.files.push({
              path: file,
              before: current.get(file) ?? null,
              applied: '',
            })
        if (data.client === 'codex')
          next.environment = {
            before: saved?.environment ? saved.environment.before : environment,
            applied: data.apiKey,
          }
        for (const file of next.files)
          file.applied = hash(
            changes.has(file.path) ?
              changes.get(file.path)!
            : (current.get(file.path) ?? null),
          )
        // Persist the original snapshot before changing any client files.
        writeFileAtomically(backupPath(data.client), JSON.stringify(next))
        try {
          writeSnapshot(changes)
          if (data.client === 'codex') await writeEnvironment(data.apiKey)
        } catch (error) {
          writeSnapshot(
            new Map(
              [...changes.keys()].map((file) => [
                file,
                current.get(file) ?? null,
              ]),
            ),
          )
          if (saved)
            writeFileAtomically(backupPath(data.client), JSON.stringify(saved))
          else fs.rmSync(backupPath(data.client), { force: true })
          throw error
        }
        let pluginError: string | undefined
        let pluginFailure: ClientSetupResult['pluginFailure']
        if (data.client === 'claude' || data.client === 'harness') {
          try {
            if (data.client === 'claude')
              await installClaudePlugins(
                data.plugins,
                beforeStatus.plugins,
                next,
              )
            else
              await run('dsh', [
                'plugin',
                '--profile',
                data.profile,
                'add',
                'dsh-copilot-api',
              ])
          } catch (error) {
            pluginError = errorCode(error)
            if (error instanceof ClientCommandError)
              pluginFailure = error.details
          }
        }
        for (const file of next.files) file.applied = hash(readFile(file.path))
        writeFileAtomically(backupPath(data.client), JSON.stringify(next))
        return {
          status: await status(data.client),
          ...(pluginError ? { pluginError } : {}),
          ...(pluginFailure ? { pluginFailure } : {}),
        }
      })
    },
    restore(
      clientInput: unknown,
      expectedRevision: unknown,
    ): Promise<ClientRestoreResult> {
      return transaction(async () => {
        const client = clientSchema.parse(clientInput)
        const currentStatus = await status(client)
        if (currentStatus.revision !== expectedRevision)
          throw new Error('conflict')
        const saved = backup(client)
        if (!saved) throw new Error('noBackup')
        const current = snapshot(client)
        if (
          saved.files.some(
            (file) => hash(current.get(file.path) ?? null) !== file.applied,
          )
        )
          throw new Error('conflict')
        if (
          saved.environment
          && (await readEnvironment()) !== saved.environment.applied
        )
          throw new Error('conflict')
        // Remove only user-scope plugins first installed by this integration;
        // keep their data and leave pre-existing installations alone.
        let pluginError: string | undefined
        let pluginFailure: ClientRestoreResult['pluginFailure']
        if (client === 'claude') {
          for (const plugin of [...(saved.plugins ?? [])]) {
            try {
              await run('claude', [
                'plugin',
                'uninstall',
                `${plugin}@copilot-api-marketplace`,
                '--scope',
                'user',
                '--keep-data',
              ])
              saved.plugins = saved.plugins?.filter((item) => item !== plugin)
            } catch (error) {
              // Plugin cleanup must not prevent restoring configuration or keys.
              if (!pluginError) {
                pluginError = errorCode(error)
                if (error instanceof ClientCommandError)
                  pluginFailure = error.details
              }
            }
            for (const file of saved.files)
              file.applied = hash(readFile(file.path))
            writeFileAtomically(backupPath(client), JSON.stringify(saved))
          }
        }
        try {
          writeSnapshot(
            new Map(saved.files.map((file) => [file.path, file.before])),
          )
          if (saved.environment)
            await writeEnvironment(saved.environment.before)
        } catch (error) {
          writeSnapshot(current)
          throw error
        }
        fs.rmSync(backupPath(client))
        return {
          ...(await status(client)),
          ...(pluginError ? { pluginError } : {}),
          ...(pluginFailure ? { pluginFailure } : {}),
        }
      })
    },
    openPath(clientInput: unknown) {
      const client = clientSchema.parse(clientInput)
      return configPaths[client]
    },
  }
}

const ERROR_CODES = new Set<string>(CLIENT_ERROR_CODES)
export function errorCode(error: unknown) {
  return error instanceof Error && ERROR_CODES.has(error.message) ?
      error.message
    : 'operationFailed'
}

// CLI errors can contain configuration content. Only stable, translated error
// codes cross IPC; command output and gateway credentials never do.
export async function clientIntegrationReply<T>(
  operation: () => T | Promise<T>,
): Promise<{ data: T } | { error: string }> {
  try {
    return { data: await operation() }
  } catch (error) {
    return { error: errorCode(error) }
  }
}
