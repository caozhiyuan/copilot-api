import { z } from 'zod'

export type ConfigObject = Record<string, unknown>

const positiveInteger = z.number().int().positive()
const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: 'Must not be empty',
})
const stringMap = z.record(z.string(), z.string())
const reasoningEffort = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])
const modelReasoningEffort = z.union([reasoningEffort, z.literal('ultra')])
const pricingTier = z.looseObject({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cachedInput: z.number().nonnegative().optional(),
  cacheCreationInput: z.number().nonnegative().optional(),
  explicitCachedInput: z.number().nonnegative().optional(),
  maxInputTokens: positiveInteger.optional(),
})
const modelSchema = z.looseObject({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  contextCache: z.boolean().optional(),
  contextWindow: positiveInteger.optional(),
  maxOutputTokens: positiveInteger.optional(),
  inputModalities: z.array(z.enum(['text', 'image'])).optional(),
  reasoningEfforts: z.array(modelReasoningEffort).optional(),
  defaultReasoningEffort: modelReasoningEffort.optional(),
  supportPdf: z.boolean().optional(),
  toolContentSupportType: z.array(z.enum(['array', 'image', 'pdf'])).optional(),
  type: z
    .enum(['anthropic', 'openai-compatible', 'openai-responses', 'google'])
    .optional(),
  reasoningField: z.enum(['reasoning', 'reasoning_content']).optional(),
  pricing: pricingTier
    .extend({
      offPeak: pricingTier.optional(),
      tiers: z.array(pricingTier).optional(),
      peakWindows: z
        .array(
          z.looseObject({
            startMinuteUtc: z.number(),
            endMinuteUtc: z.number(),
            weekdays: z.array(z.number()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
})
const providerSchema = z.looseObject({
  type: z.string().optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  modelsDevProviderId: z.string().optional(),
  apiKey: z.string().optional(),
  authType: z
    .enum([
      'authorization',
      'azure-entra',
      'oauth2',
      'x-api-key',
      'x-goog-api-key',
    ])
    .optional(),
  accountId: z.string().optional(),
  pricingCurrency: z.string().optional(),
  agentsModels: z.array(z.string()).optional(),
  models: z.record(z.string(), modelSchema).optional(),
})
const imageModel = z
  .string()
  .refine((value) => value === '' || /^xai\/.+/.test(value), {
    message: 'Use an xai/model alias, or an empty string for the default route',
  })

// Validate known fields without stripping future or provider-specific fields.
// The original parsed document is persisted, not Zod's transformed output.
export const appConfigSchema = z.looseObject({
  auth: z
    .looseObject({
      apiKeys: z.array(nonEmptyString).optional(),
      adminApiKey: z.string().optional(),
    })
    .optional(),
  providers: z.record(z.string(), providerSchema).optional(),
  modelMappings: z.record(nonEmptyString, nonEmptyString).optional(),
  extraPrompts: stringMap.optional(),
  smallModels: stringMap.optional(),
  contextManagement: z
    .looseObject({
      messages: z.boolean().optional(),
      responses: z.boolean().optional(),
    })
    .optional(),
  opencodeModelContextWindow: positiveInteger.optional(),
  modelResponsesApiCompactThresholds: z
    .record(z.string(), positiveInteger)
    .optional(),
  modelReasoningEfforts: z.record(z.string(), reasoningEffort).optional(),
  useMessagesApi: z.boolean().optional(),
  useResponsesApiWebSocket: z.boolean().optional(),
  upstreamTransport: z
    .looseObject({
      headersTimeoutMs: positiveInteger.optional(),
      streamInactivityTimeoutMs: positiveInteger.optional(),
      websocketMaxBufferedBytes: positiveInteger.optional(),
      websocketMaxBufferedMessages: positiveInteger.optional(),
      websocketOpenTimeoutMs: positiveInteger.optional(),
      websocketPoolIdleTimeoutMs: positiveInteger.optional(),
    })
    .optional(),
  anthropicApiKey: z.string().optional(),
  useResponsesApiWebSearch: z.boolean().optional(),
  alphaSearchCodexPriority: z.boolean().optional(),
  alphaSearchModel: z.string().optional(),
  messageApiWebSearchModel: z.string().optional(),
  imageGenerationModel: imageModel.optional(),
  imageEditModel: imageModel.optional(),
  claudeAutoModel: z.string().optional(),
  claudeTokenMultiplier: z.number().positive().optional(),
})

export function isConfigObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseConfigContent(content: string): ConfigObject {
  let config: unknown
  try {
    config = JSON.parse(content) as unknown
  } catch {
    // JSON.parse messages can contain pieces of a secret-bearing source line.
    throw new Error('Invalid JSON. Check commas, quotes and brackets.')
  }
  if (!isConfigObject(config)) throw new Error('Config must be a JSON object.')
  return config
}

export function validateConfigContent(content: string): ConfigObject {
  const config = parseConfigContent(content)
  const rejectMasks = (value: unknown, path: string[]) => {
    if (value === '••••••' && path.some((key) => sensitiveKey.test(key))) {
      throw new Error('Masked credential placeholders cannot be saved.')
    }
    if (Array.isArray(value)) {
      for (const entry of value) rejectMasks(entry, path)
    } else if (isConfigObject(value)) {
      for (const [key, entry] of Object.entries(value))
        rejectMasks(entry, [...path, key])
    }
  }
  rejectMasks(config, [])
  const result = appConfigSchema.safeParse(config)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(
      `${issue.path.map(String).join('.') || 'config'}: ${issue.message}`,
    )
  }
  return config
}

export function getConfigValue(config: ConfigObject, path: string): unknown {
  let value: unknown = config
  for (const key of path.split('.')) {
    if (!isConfigObject(value) || !Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return value
}

// Only static field paths use dot notation. Model/provider names remain keys
// of an entire record, so dots in their names are never treated as paths.
export function setConfigValue(
  config: ConfigObject,
  path: string,
  value: unknown,
): ConfigObject {
  const next = structuredClone(config)
  const keys = path.split('.')
  const leaf = keys.pop()!
  let target = next
  for (const key of keys) {
    const existing: unknown =
      Object.hasOwn(target, key) ? target[key] : undefined
    const child = isConfigObject(existing) ? existing : {}
    Object.defineProperty(target, key, {
      value: child,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    target = child
  }
  if (value === undefined) delete target[leaf]
  else
    Object.defineProperty(target, leaf, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  return next
}

export function serializeConfig(config: ConfigObject): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

const sensitiveKey =
  /(?:api[-_]?keys?|token|^tokens|password|secret|authorization|cookies?)$/i

export function maskConfigValue(value: unknown, path: string[] = []): unknown {
  if (path.some((key) => sensitiveKey.test(key))) {
    return value === undefined ? undefined : '••••••'
  }
  if (Array.isArray(value))
    return value.map((entry) => maskConfigValue(entry, path))
  if (!isConfigObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      maskConfigValue(entry, [...path, key]),
    ]),
  )
}

export interface ConfigChange {
  path: string
  before: unknown
  after: unknown
}

export function getConfigChanges(
  before: ConfigObject,
  after: ConfigObject,
): ConfigChange[] {
  const changes: ConfigChange[] = []
  const visit = (left: unknown, right: unknown, path: string[]) => {
    if (isConfigObject(left) && isConfigObject(right)) {
      for (const key of new Set([
        ...Object.keys(left),
        ...Object.keys(right),
      ])) {
        visit(
          Object.hasOwn(left, key) ? left[key] : undefined,
          Object.hasOwn(right, key) ? right[key] : undefined,
          [...path, key],
        )
      }
    } else if (JSON.stringify(left) !== JSON.stringify(right)) {
      changes.push({
        path: path.join('.'),
        before: maskConfigValue(left, path),
        after: maskConfigValue(right, path),
      })
    }
  }
  visit(before, after, [])
  return changes
}
