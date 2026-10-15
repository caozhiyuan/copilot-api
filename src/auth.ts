#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import {
  getRawProviderConfig,
  isSupportedProviderType,
  normalizeProviderBaseUrl,
  setProviderConfig,
  setConfiguredApiKeys,
  SUPPORTED_PROVIDER_TYPES,
  type ProviderAuthType,
  type ProviderConfig,
  type ProviderType,
} from "./lib/config"
import { loginCodex } from "./lib/oauth/codex"
import { loginXai } from "./lib/oauth/xai"
import {
  persistXaiCredentials,
  getXaiAccounts,
  selectXaiAccount,
  removeXaiAccount,
} from "./lib/xai-token"
import {
  loadModelsDevProviderOptions,
  type ModelsDevProviderOption,
} from "./lib/models-dev-cache"
import { PATHS, ensurePaths } from "./lib/paths"
import { getConfiguredApiKeys } from "./lib/request-auth"
import {
  QUICK_PROVIDER_CONFIGS,
  type QuickProviderName,
} from "./lib/quick-providers"
import { prompt } from "./lib/interactive-prompt"
import { state } from "./lib/state"
import {
  getCodexAccounts,
  persistCodexCredentials,
  removeCodexAccount,
  selectCodexAccount,
  setupGitHubToken,
  type CodexAccountSummary,
} from "./lib/token"

interface RunAuthOptions {
  alias?: string
  provider?: string
  verbose: boolean
  showToken: boolean
}

const authArgs = {
  provider: {
    type: "string",
    description:
      "Provider to log in with or configure (copilot, codex, xai, opencode-go, kimi, deepseek, dashscope, openrouter, custom)",
  },
  alias: {
    type: "string",
    description: "Optional alias for a Codex or xAI account",
  },
  verbose: {
    alias: "v",
    type: "boolean",
    default: false,
    description: "Enable verbose logging",
  },
  "show-token": {
    type: "boolean",
    default: false,
    description: "Show provider access token on auth",
  },
} as const

const BUILTIN_PROVIDER_NAMES = ["copilot", "codex", "xai"] as const
const QUICK_PROVIDER_NAMES = Object.keys(
  QUICK_PROVIDER_CONFIGS,
) as Array<QuickProviderName>
const AUTH_PROVIDER_NAMES = [
  ...BUILTIN_PROVIDER_NAMES,
  ...QUICK_PROVIDER_NAMES,
  "custom",
] as const
const CUSTOM_PROVIDER_AUTH_TYPE_OPTION = "__default__"
const QUICK_PROVIDER_DEFAULT_TYPE_OPTION = "__default__"
const CUSTOM_PROVIDER_AUTH_TYPES = [
  "x-api-key",
  "x-goog-api-key",
  "authorization",
] as const

type BuiltinProviderName = (typeof BUILTIN_PROVIDER_NAMES)[number]
type AuthProviderName = (typeof AUTH_PROVIDER_NAMES)[number]
type CustomProviderAuthType = (typeof CUSTOM_PROVIDER_AUTH_TYPES)[number]

const BUILTIN_PROVIDER_LABELS: Record<BuiltinProviderName, string> = {
  copilot: "GitHub Copilot",
  codex: "OpenAI Codex",
  xai: "xAI (SuperGrok Subscription)",
}
const AUTH_PROVIDER_LABELS: Record<AuthProviderName, string> = {
  ...BUILTIN_PROVIDER_LABELS,
  "opencode-go": "OpenCode Go",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  dashscope: "DashScope",
  openrouter: "OpenRouter",
  custom: "Custom provider",
}

function isAuthProviderName(
  providerName: string,
): providerName is AuthProviderName {
  return AUTH_PROVIDER_NAMES.includes(providerName as AuthProviderName)
}

function isCustomProviderAuthType(
  value: string,
): value is CustomProviderAuthType {
  return CUSTOM_PROVIDER_AUTH_TYPES.includes(value as CustomProviderAuthType)
}

function isQuickProviderName(
  providerName: AuthProviderName,
): providerName is QuickProviderName {
  return QUICK_PROVIDER_NAMES.includes(providerName as QuickProviderName)
}

async function resolveProviderSelection(
  providerArg: string | undefined,
): Promise<AuthProviderName> {
  const availableProviders = [...AUTH_PROVIDER_NAMES]

  if (providerArg !== undefined) {
    const providerName = providerArg.trim()
    if (!isAuthProviderName(providerName)) {
      throw new Error(
        `Unknown provider '${providerArg}'. Expected one of: ${availableProviders.join(", ")}`,
      )
    }
    return providerName
  }

  if (availableProviders.length === 1) {
    return availableProviders[0]
  }

  const provider = await prompt("Select a provider to log in with", {
    type: "select",
    options: availableProviders.map((providerName) => ({
      label: `${AUTH_PROVIDER_LABELS[providerName]} (${providerName})`,
      value: providerName,
    })),
  })

  if (!provider || !isAuthProviderName(provider)) {
    throw new Error("No provider selected")
  }

  return provider
}

function assertCustomProviderName(providerName: string): void {
  if (!providerName) {
    throw new Error("Provider name must be a non-empty string")
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(providerName)) {
    throw new Error(
      "Provider name must start with a letter or number and contain only letters, numbers, underscores, or hyphens",
    )
  }

  if (
    providerName === "copilot"
    || providerName === "github-copilot"
    || providerName === "codex"
  ) {
    throw new Error(
      `Provider name '${providerName}' is reserved for a builtin provider`,
    )
  }
}

async function promptRequiredText(
  message: string,
  fieldName: string,
): Promise<string> {
  const value = await prompt(message, { type: "text" })
  const normalizedValue = typeof value === "string" ? value.trim() : ""
  if (!normalizedValue) {
    throw new Error(`${fieldName} must be a non-empty string`)
  }
  return normalizedValue
}

function canUseMaskedPrompt(): boolean {
  return Boolean(
    process.stdin.isTTY
      && process.stdout.isTTY
      && typeof process.stdin.setRawMode === "function",
  )
}

async function promptMaskedText(message: string): Promise<string> {
  if (!canUseMaskedPrompt()) {
    const value = await prompt(message, { type: "text" })
    return typeof value === "string" ? value : ""
  }

  return await new Promise<string>((resolve, reject) => {
    let value = ""
    const rawModeWasEnabled = process.stdin.isRaw === true

    function cleanup(): void {
      process.stdin.off("data", onData)
      process.stdin.setRawMode(rawModeWasEnabled)
      process.stdin.pause()
    }

    function finish(): void {
      cleanup()
      process.stdout.write("\n")
      resolve(value)
    }

    function cancel(): void {
      cleanup()
      process.stdout.write("\n")
      reject(new Error("Prompt cancelled"))
    }

    function onData(chunk: Buffer): void {
      const input = chunk.toString("utf8")

      if (input.startsWith("\u001B")) {
        return
      }

      for (const char of input) {
        if (char === "\u0003") {
          cancel()
          return
        }

        if (char === "\r" || char === "\n") {
          finish()
          return
        }

        if (char === "\b" || char === "\u007F") {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write("\b \b")
          }
          continue
        }

        if (char >= " ") {
          value += char
          process.stdout.write("*")
        }
      }
    }

    process.stdout.write(`${message}: `)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}

async function promptRequiredSecret(
  message: string,
  fieldName: string,
): Promise<string> {
  const value = await promptMaskedText(message)
  const normalizedValue = value.trim()
  if (!normalizedValue) {
    throw new Error(`${fieldName} must be a non-empty string`)
  }
  return normalizedValue
}

async function promptCustomProviderName(defaultName?: string): Promise<string> {
  const value = await prompt("Enter provider name", {
    type: "text",
    ...(defaultName ? { default: defaultName, initial: defaultName } : {}),
  })
  const providerName = (value || defaultName || "").trim()
  assertCustomProviderName(providerName)
  return providerName
}

async function promptCustomProviderType(
  defaultType?: ProviderType,
): Promise<ProviderType> {
  const providerType = await prompt("Select provider type", {
    type: "select",
    initial: defaultType,
    options: SUPPORTED_PROVIDER_TYPES.map((type) => ({
      label: type,
      value: type,
    })),
  })

  if (
    typeof providerType !== "string"
    || !isSupportedProviderType(providerType)
  ) {
    throw new Error("No provider type selected")
  }

  return providerType
}

async function promptModelsDevProvider(): Promise<
  ModelsDevProviderOption | undefined
> {
  const source = await prompt("Choose custom provider source", {
    type: "select",
    options: [
      { label: "Enter manually", value: "manual" },
      { label: "Choose from models.dev", value: "models-dev" },
    ],
  })
  if (source === "manual") return undefined
  if (source !== "models-dev") throw new Error("No provider source selected")

  const providers = await loadModelsDevProviderOptions()
  const query = (
    (await prompt("Search models.dev providers (blank to list all)", {
      type: "text",
    })) ?? ""
  )
    .trim()
    .toLowerCase()
  const matches = providers.filter(
    (provider) =>
      provider.id.toLowerCase().includes(query)
      || provider.name.toLowerCase().includes(query),
  )
  if (matches.length === 0) {
    throw new Error("No matching models.dev providers with a supported API URL")
  }
  const selectedId = await prompt("Select a models.dev provider", {
    type: "select",
    options: matches.map((provider) => ({
      label: `${provider.name} (${provider.id}) — ${provider.type}`,
      value: provider.id,
    })),
  })
  const selectedProvider = matches.find(
    (provider) => provider.id === selectedId,
  )
  if (!selectedProvider) throw new Error("No models.dev provider selected")
  return selectedProvider
}

async function promptQuickProviderType(
  defaultType: ProviderType,
): Promise<ProviderType> {
  const providerType = await prompt(
    `Select provider type (default: ${defaultType})`,
    {
      type: "select",
      options: [
        {
          label: `Default (${defaultType})`,
          value: QUICK_PROVIDER_DEFAULT_TYPE_OPTION,
        },
        ...SUPPORTED_PROVIDER_TYPES.map((type) => ({
          label: type,
          value: type,
        })),
      ],
    },
  )

  if (providerType === QUICK_PROVIDER_DEFAULT_TYPE_OPTION) {
    return defaultType
  }

  if (
    typeof providerType === "string"
    && isSupportedProviderType(providerType)
  ) {
    return providerType
  }

  throw new Error("No provider type selected")
}

function getDefaultProviderAuthType(
  providerType: ProviderType,
): ProviderAuthType {
  if (providerType === "google") return "x-goog-api-key"
  return providerType === "anthropic" ? "x-api-key" : "authorization"
}

async function promptCustomProviderAuthType(
  providerType: ProviderType,
): Promise<ProviderAuthType | undefined> {
  const defaultAuthType = getDefaultProviderAuthType(providerType)
  const authType = await prompt("Select provider auth type", {
    type: "select",
    options: [
      {
        label: `Default (${defaultAuthType})`,
        value: CUSTOM_PROVIDER_AUTH_TYPE_OPTION,
      },
      ...CUSTOM_PROVIDER_AUTH_TYPES.map((value) => ({
        label: value,
        value,
      })),
    ],
  })

  if (authType === CUSTOM_PROVIDER_AUTH_TYPE_OPTION) {
    return undefined
  }

  if (typeof authType === "string" && isCustomProviderAuthType(authType)) {
    return authType
  }

  throw new Error("No provider auth type selected")
}

async function promptQuickProviderBaseUrl(
  defaultBaseUrl: string,
): Promise<string> {
  const value = await prompt(
    `Enter provider baseUrl (default: ${defaultBaseUrl})`,
    {
      type: "text",
      default: defaultBaseUrl,
      initial: defaultBaseUrl,
    },
  )
  const baseUrl = normalizeProviderBaseUrl(
    typeof value === "string" && value.trim() ? value : defaultBaseUrl,
  )
  if (!baseUrl) {
    throw new Error("baseUrl must be a non-empty string")
  }

  return baseUrl
}

function buildCustomProviderConfig(
  existingProviderConfig: ProviderConfig,
  options: {
    apiKey: string
    authType?: ProviderAuthType
    baseUrl: string
    pricingCurrency?: string
    type: ProviderType
    modelsDevProviderId?: string
  },
): ProviderConfig {
  return {
    type: options.type,
    enabled: true,
    baseUrl: options.baseUrl,
    ...(options.modelsDevProviderId && {
      modelsDevProviderId: options.modelsDevProviderId,
    }),
    apiKey: options.apiKey,
    ...(options.authType ? { authType: options.authType } : {}),
    pricingCurrency:
      options.pricingCurrency ?? existingProviderConfig.pricingCurrency,
    ...(existingProviderConfig.agentsModels !== undefined ?
      { agentsModels: existingProviderConfig.agentsModels }
    : {}),
    ...(existingProviderConfig.models ?
      { models: existingProviderConfig.models }
    : {}),
  }
}

async function configureCustomProvider(): Promise<void> {
  const catalogProvider = await promptModelsDevProvider()
  const providerName = await promptCustomProviderName(catalogProvider?.id)
  const type = await promptCustomProviderType(catalogProvider?.type)
  const baseUrl =
    catalogProvider ?
      await promptQuickProviderBaseUrl(catalogProvider.api)
    : normalizeProviderBaseUrl(
        await promptRequiredText("Enter provider baseUrl", "baseUrl"),
      )
  if (!baseUrl) {
    throw new Error("baseUrl must be a non-empty string")
  }

  const apiKey = await promptRequiredSecret("Enter provider apiKey", "apiKey")
  const authType = await promptCustomProviderAuthType(type)
  const existingProviderConfig = getRawProviderConfig(providerName) ?? {}

  setProviderConfig(
    providerName,
    buildCustomProviderConfig(existingProviderConfig, {
      apiKey,
      authType,
      baseUrl,
      modelsDevProviderId: catalogProvider?.id,
      type,
    }),
  )

  consola.success(
    `Custom provider '${providerName}' written to ${PATHS.CONFIG_PATH}`,
  )
}

async function configureQuickProvider(
  providerName: QuickProviderName,
): Promise<void> {
  const defaultProviderConfig = QUICK_PROVIDER_CONFIGS[providerName]
  const apiKey = await promptRequiredSecret(
    `Enter ${providerName} apiKey`,
    "apiKey",
  )
  const type =
    defaultProviderConfig.editableType ?
      await promptQuickProviderType(defaultProviderConfig.type)
    : defaultProviderConfig.type
  const baseUrl = await promptQuickProviderBaseUrl(
    defaultProviderConfig.baseUrl,
  )
  const existingProviderConfig = getRawProviderConfig(providerName) ?? {}

  setProviderConfig(
    providerName,
    buildCustomProviderConfig(existingProviderConfig, {
      apiKey,
      baseUrl,
      pricingCurrency: defaultProviderConfig.pricingCurrency,
      type,
    }),
  )

  consola.success(
    `${AUTH_PROVIDER_LABELS[providerName]} provider '${providerName}' written to ${PATHS.CONFIG_PATH}`,
  )
}

async function loginWithCodex(alias?: string): Promise<void> {
  const credentials = await loginCodex({
    onAuth(info) {
      consola.info("Open the following URL to authenticate with Codex:")
      consola.log(info.url)
      if (info.instructions) {
        consola.info(info.instructions)
      }
    },
    onPrompt(message) {
      return prompt(message, { type: "text" }).then((value) => value ?? "")
    },
    onProgress(message) {
      consola.debug(message)
    },
  })

  await persistCodexCredentials(credentials, {
    activateAccount: true,
    alias,
    enableProvider: true,
  })
  consola.success(
    `Codex provider config written to ${PATHS.CONFIG_PATH} and credentials written to ${PATHS.CODEX_CREDENTIAL_PATH}`,
  )
}

async function loginWithProvider(
  provider: AuthProviderName,
  alias?: string,
): Promise<void> {
  if (alias !== undefined && provider !== "codex" && provider !== "xai") {
    throw new Error("--alias is only supported with the codex or xai provider")
  }

  if (provider === "copilot") {
    await setupGitHubToken({ force: true })
    consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
    return
  }

  if (provider === "codex") {
    await loginWithCodex(alias)
    return
  }

  if (provider === "xai") {
    const credentials = await loginXai({
      onAuth(info) {
        consola.info("Open the following URL to authenticate with xAI:")
        consola.log(info.url)
        consola.info(
          `Open ${info.verificationUri} on any device and enter code: ${info.userCode}`,
        )
      },
    })
    await persistXaiCredentials(credentials, { alias })
    consola.success(
      `xAI provider config written to ${PATHS.CONFIG_PATH} and credentials written to ${PATHS.XAI_CREDENTIAL_PATH}`,
    )
    return
  }

  if (isQuickProviderName(provider)) {
    await configureQuickProvider(provider)
    return
  }

  await configureCustomProvider()
}

export async function runProviderSetup(): Promise<void> {
  const provider = await resolveProviderSelection(undefined)
  consola.info(`Logging in with ${AUTH_PROVIDER_LABELS[provider]}`)
  await loginWithProvider(provider)
}

export async function runAuthLogin(options: RunAuthOptions): Promise<void> {
  const tlsModule = await import("./lib/tls")
  tlsModule.enableSystemCACompat()

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()
  const provider = await resolveProviderSelection(options.provider)

  consola.info(`Logging in with ${AUTH_PROVIDER_LABELS[provider]}`)
  await loginWithProvider(provider, options.alias)
}

const authAccountArgs = {
  list: {
    alias: "l",
    type: "boolean",
    default: false,
    description: "List stored OAuth accounts",
  },
  remove: {
    alias: "r",
    type: "string",
    description:
      "Remove an OAuth account by alias or account id; the account in use cannot be removed",
  },
  use: {
    alias: "u",
    type: "string",
    description: "Select an OAuth account by alias or account id",
  },
} as const

interface RunAuthAccountsOptions {
  list?: boolean
  remove?: string
  use?: string
}

function formatOAuthAccountName(
  account: Pick<CodexAccountSummary, "accountId" | "alias">,
): string {
  return account.alias ?
      `${account.alias} (${account.accountId})`
    : account.accountId
}

function formatOAuthAccount(account: CodexAccountSummary): string {
  return `${account.active ? "*" : "-"} ${formatOAuthAccountName(account)}`
}

export async function runAuthCodex(
  options: RunAuthAccountsOptions,
): Promise<void> {
  return await runAuthAccounts("codex", options)
}

export async function runAuthAccounts(
  provider: "codex" | "xai",
  options: RunAuthAccountsOptions,
): Promise<void> {
  const label = provider === "codex" ? "Codex" : "xAI"
  const accountsApi =
    provider === "codex" ?
      {
        list: getCodexAccounts,
        select: selectCodexAccount,
        remove: removeCodexAccount,
      }
    : {
        list: getXaiAccounts,
        select: selectXaiAccount,
        remove: removeXaiAccount,
      }
  await ensurePaths()

  const operationCount = [
    options.list === true,
    options.use !== undefined,
    options.remove !== undefined,
  ].filter(Boolean).length
  if (operationCount > 1) {
    throw new Error("Use only one of --list, --use, or --remove per invocation")
  }

  if (options.use !== undefined) {
    const account = await accountsApi.select(options.use)
    consola.success(
      `Selected ${label} account ${formatOAuthAccountName(account)}`,
    )
    consola.info(`Restart the server to use the selected ${label} account.`)
    return
  }

  if (options.remove !== undefined) {
    const account = await accountsApi.remove(options.remove)
    consola.success(
      `Removed ${label} account ${formatOAuthAccountName(account)}`,
    )
    return
  }

  const accounts = await accountsApi.list()
  if (accounts.length === 0) {
    consola.info(
      `No ${label} accounts configured. Run \`copilot-api auth login --provider ${provider}\` to add one.`,
    )
    return
  }

  consola.info(`Configured ${label} accounts:`)
  for (const account of accounts) {
    consola.info(formatOAuthAccount(account))
  }
}

const authKeysArgs = {
  add: {
    alias: "a",
    type: "string",
    description: "Add an API key for gateway authentication",
  },
  remove: {
    alias: "r",
    type: "string",
    description: "Remove an API key",
  },
  list: {
    alias: "l",
    type: "boolean",
    default: false,
    description: "List configured API keys",
  },
  clear: {
    type: "boolean",
    default: false,
    description: "Remove all configured API keys",
  },
} as const

interface RunAuthKeysOptions {
  add?: string
  remove?: string
  list?: boolean
  clear?: boolean
}

function normalizeAuthKeyValue(value: string): string {
  const normalizedKey = value.trim()
  if (!normalizedKey) {
    throw new Error("API key must be a non-empty string")
  }
  return normalizedKey
}

export async function runAuthKeys(options: RunAuthKeysOptions): Promise<void> {
  const tlsModule = await import("./lib/tls")
  tlsModule.enableSystemCACompat()

  await ensurePaths()

  const operations = [
    ...(options.add !== undefined ? ["add"] : []),
    ...(options.remove !== undefined ? ["remove"] : []),
    ...(options.list ? ["list"] : []),
    ...(options.clear ? ["clear"] : []),
  ]
  if (operations.length > 1) {
    throw new Error(
      "Use only one of --add, --remove, --list, or --clear per invocation",
    )
  }

  const operation = operations[0] ?? "list"

  if (operation === "add") {
    const apiKey = normalizeAuthKeyValue(options.add ?? "")
    const currentKeys = getConfiguredApiKeys()
    if (currentKeys.includes(apiKey)) {
      consola.info(
        `API key already configured. ${currentKeys.length} API key(s) configured.`,
      )
      return
    }
    const storedKeys = setConfiguredApiKeys([...currentKeys, apiKey])
    consola.success(
      `API key added to ${PATHS.CONFIG_PATH}. ${storedKeys.length} API key(s) configured.`,
    )
    return
  }

  if (operation === "remove") {
    const apiKey = normalizeAuthKeyValue(options.remove ?? "")
    const currentKeys = getConfiguredApiKeys()
    if (!currentKeys.includes(apiKey)) {
      consola.info(
        `API key not found. ${currentKeys.length} API key(s) configured.`,
      )
      return
    }
    const storedKeys = setConfiguredApiKeys(
      currentKeys.filter((key) => key !== apiKey),
    )
    consola.success(
      `API key removed from ${PATHS.CONFIG_PATH}. ${storedKeys.length} API key(s) configured.`,
    )
    return
  }

  if (operation === "clear") {
    setConfiguredApiKeys([])
    consola.success(`Removed all API keys from ${PATHS.CONFIG_PATH}.`)
    return
  }

  const currentKeys = getConfiguredApiKeys()
  if (currentKeys.length === 0) {
    consola.info(
      "No API keys configured. Run `npx @jeffreycao/copilot-api@latest auth keys --add <key>` to add one.",
    )
    return
  }
  consola.info("Configured API keys:")
  for (const key of currentKeys) {
    consola.info(`- ${key}`)
  }
}

const authLogin = defineCommand({
  meta: {
    name: "login",
    description:
      "Authenticate or configure a provider without running the server",
  },
  args: authArgs,
  run({ args }) {
    return runAuthLogin({
      alias: args.alias,
      provider: args.provider,
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})

const authKeys = defineCommand({
  meta: {
    name: "keys",
    description: "Manage gateway API keys (auth.apiKeys) in the config",
  },
  args: authKeysArgs,
  run({ args }) {
    return runAuthKeys({
      add: args.add,
      remove: args.remove,
      list: args.list,
      clear: args.clear,
    })
  },
})

const authCodex = defineCommand({
  meta: {
    name: "codex",
    description: "List, select, or remove stored Codex accounts",
  },
  args: authAccountArgs,
  run({ args }) {
    return runAuthCodex({
      list: args.list,
      remove: args.remove,
      use: args.use,
    })
  },
})

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run authentication flows without running the server",
  },
  args: authArgs,
  subCommands: {
    codex: authCodex,
    xai: defineCommand({
      meta: { name: "xai", description: "Manage stored xAI accounts" },
      args: authAccountArgs,
      run({ args }) {
        return runAuthAccounts("xai", {
          list: args.list,
          remove: args.remove,
          use: args.use,
        })
      },
    }),
    login: authLogin,
    keys: authKeys,
  },
  run({ args }) {
    if ((args._[0] ?? "").trim()) {
      return
    }

    return runAuthLogin({
      alias: args.alias,
      provider: args.provider,
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})
