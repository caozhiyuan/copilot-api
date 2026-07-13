#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import {
  getRawProviderConfig,
  isSupportedProviderType,
  normalizeProviderBaseUrl,
  setProviderConfig,
  SUPPORTED_PROVIDER_TYPES,
  type ProviderAuthType,
  type ProviderConfig,
  type ProviderType,
} from "./lib/config"
import { loginCodex } from "./lib/oauth/codex"
import { PATHS, ensurePaths } from "./lib/paths"
import {
  QUICK_PROVIDER_CONFIGS,
  type QuickProviderName,
} from "./lib/quick-providers"
import { state } from "./lib/state"
import { persistCodexCredentials, setupGitHubToken } from "./lib/token"

interface RunAuthOptions {
  provider?: string
  verbose: boolean
  showToken: boolean
}

const authArgs = {
  provider: {
    type: "string",
    description:
      "Provider to log in with or configure (copilot, codex, opencode-go, deepseek, dashscope, openrouter, custom)",
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

const BUILTIN_PROVIDER_NAMES = ["copilot", "codex"] as const
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
const CUSTOM_PROVIDER_AUTH_TYPES = ["x-api-key", "authorization"] as const

type BuiltinProviderName = (typeof BUILTIN_PROVIDER_NAMES)[number]
type AuthProviderName = (typeof AUTH_PROVIDER_NAMES)[number]
type CustomProviderAuthType = (typeof CUSTOM_PROVIDER_AUTH_TYPES)[number]

const BUILTIN_PROVIDER_LABELS: Record<BuiltinProviderName, string> = {
  copilot: "GitHub Copilot",
  codex: "OpenAI Codex",
}
const AUTH_PROVIDER_LABELS: Record<AuthProviderName, string> = {
  ...BUILTIN_PROVIDER_LABELS,
  "opencode-go": "OpenCode Go",
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

  const provider = await consola.prompt("Select a provider to log in with", {
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

  if (providerName === "copilot" || providerName === "codex") {
    throw new Error(
      `Provider name '${providerName}' is reserved for a builtin provider`,
    )
  }
}

async function promptRequiredText(
  message: string,
  fieldName: string,
): Promise<string> {
  const value = await consola.prompt(message, { type: "text" })
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
    const value = await consola.prompt(message, { type: "text" })
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

async function promptCustomProviderName(): Promise<string> {
  const providerName = await promptRequiredText(
    "Enter provider name",
    "Provider name",
  )
  assertCustomProviderName(providerName)
  return providerName
}

async function promptCustomProviderType(): Promise<ProviderType> {
  const providerType = await consola.prompt("Select provider type", {
    type: "select",
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

async function promptQuickProviderType(
  defaultType: ProviderType,
): Promise<ProviderType> {
  const providerType = await consola.prompt(
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
  return providerType === "anthropic" ? "x-api-key" : "authorization"
}

async function promptCustomProviderAuthType(
  providerType: ProviderType,
): Promise<ProviderAuthType | undefined> {
  const defaultAuthType = getDefaultProviderAuthType(providerType)
  const authType = await consola.prompt("Select provider auth type", {
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
  const value = await consola.prompt(
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
  },
): ProviderConfig {
  return {
    type: options.type,
    enabled: true,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    ...(options.authType ? { authType: options.authType } : {}),
    pricingCurrency:
      options.pricingCurrency ?? existingProviderConfig.pricingCurrency,
    ...(existingProviderConfig.imageEndpoints ?
      { imageEndpoints: existingProviderConfig.imageEndpoints }
    : {}),
    ...(existingProviderConfig.models ?
      { models: existingProviderConfig.models }
    : {}),
  }
}

async function configureCustomProvider(): Promise<void> {
  const providerName = await promptCustomProviderName()
  const type = await promptCustomProviderType()
  const baseUrl = normalizeProviderBaseUrl(
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

async function loginWithCodex(): Promise<void> {
  const credentials = await loginCodex({
    onAuth(info) {
      consola.info("Open the following URL to authenticate with Codex:")
      consola.log(info.url)
      if (info.instructions) {
        consola.info(info.instructions)
      }
    },
    onPrompt(message) {
      return consola.prompt(message, {
        type: "text",
      })
    },
    onProgress(message) {
      consola.debug(message)
    },
  })

  await persistCodexCredentials(credentials, { enableProvider: true })
  consola.success(
    `Codex provider config written to ${PATHS.CONFIG_PATH} and credentials written to ${PATHS.CODEX_CREDENTIAL_PATH}`,
  )
}

async function loginWithProvider(provider: AuthProviderName): Promise<void> {
  if (provider === "copilot") {
    await setupGitHubToken({ force: true })
    consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
    return
  }

  if (provider === "codex") {
    await loginWithCodex()
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
  await loginWithProvider(provider)
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
      provider: args.provider,
      verbose: args.verbose,
      showToken: args["show-token"],
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
    login: authLogin,
  },
  run({ args }) {
    if ((args._[0] ?? "").trim()) {
      return
    }

    return runAuthLogin({
      provider: args.provider,
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})
