import {
  defaultConfig,
  defaultContextManagement,
  getConfig,
  readEditableConfigFromDisk,
  reloadConfig,
  writeConfigToDisk,
} from "./config-store"

const GPT_MODEL_PATTERN = /^gpt-(\d+)(?:\.(\d+))?/

function isGpt53OrAbove(model: string): boolean {
  const match = GPT_MODEL_PATTERN.exec(model)
  if (!match) {
    return false
  }
  const majorVersion = Number.parseInt(match[1], 10)
  if (majorVersion > 5) {
    return true
  }
  if (majorVersion !== 5) {
    return false
  }
  const minorVersion = match[2] ? Number.parseInt(match[2], 10) : 0
  return minorVersion >= 3
}

export function isGpt56OrAbove(model: string): boolean {
  const match = GPT_MODEL_PATTERN.exec(model)
  if (!match) {
    return false
  }
  const majorVersion = Number.parseInt(match[1], 10)
  if (majorVersion > 5) {
    return true
  }
  if (majorVersion !== 5) {
    return false
  }
  const minorVersion = match[2] ? Number.parseInt(match[2], 10) : 0
  return minorVersion >= 6
}

const gpt5CommentaryPrompt = `# Working with the user

You interact with the user through a terminal. You have 2 ways of communicating with the users:  
- Share intermediary updates in \`commentary\` channel.  
- After you have completed all your work, send a message to the \`final\` channel.  

## Intermediary updates

- Intermediary updates go to the \`commentary\` channel.
- User updates are short updates while you are working, they are NOT final answers.
- You use 1-2 sentence user updates to communicate progress and new information to the user as you are doing work.
- Do not begin responses with conversational interjections or meta commentary. Avoid openers such as acknowledgements (“Done —”, “Got it”, “Great question, ”) or framing phrases.
- You provide user updates frequently, every 20s.
- Before exploring or doing substantial work, you start with a user update acknowledging the request and explaining your first step. You should include your understanding of the user request and explain what you will do. Avoid commenting on the request or using starters such as "Got it -" or "Understood -" etc.
- When exploring, e.g. searching, reading files, you provide user updates as you go, every 20s, explaining what context you are gathering and what you've learned. Vary your sentence structure when providing these updates to avoid sounding repetitive - in particular, don't start each sentence the same way.
- After you have sufficient context, and the work is substantial, you provide a longer plan (this is the only user update that may be longer than 2 sentences and can contain formatting).
- Before performing file edits of any kind, you provide updates explaining what edits you are making.
- As you are thinking, you very frequently provide updates even if not taking any actions, informing the user of your progress. You interrupt your thinking and send multiple updates in a row if thinking for more than 100 words.
- Tone of your updates MUST match your personality.`

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  const userPrompt = config.extraPrompts?.[model]
  if (userPrompt !== undefined) {
    return userPrompt
  }
  return isGpt53OrAbove(model) ? gpt5CommentaryPrompt : ""
}

export function getModelMappings(): Record<string, string> {
  const config = getConfig()
  const modelMappings = config.modelMappings
  if (!modelMappings) {
    return { ...defaultConfig.modelMappings }
  }

  const validMappings: Record<string, string> = {}
  for (const [sourceModel, targetModel] of Object.entries(modelMappings)) {
    if (
      !sourceModel
      || typeof targetModel !== "string"
      || targetModel.length === 0
    ) {
      continue
    }
    validMappings[sourceModel] = targetModel
  }

  return validMappings
}

function validateModelMappings(
  modelMappings: Record<string, string>,
): Record<string, string> {
  const validatedMappings: Record<string, string> = {}
  for (const [sourceModel, targetModel] of Object.entries(modelMappings)) {
    if (!sourceModel || !targetModel) {
      throw new Error(
        "Each model mapping must use non-empty source and target values.",
      )
    }
    validatedMappings[sourceModel] = targetModel
  }

  return validatedMappings
}

export function setModelMappings(
  modelMappings: Record<string, string>,
): Record<string, string> {
  const nextConfig = {
    ...readEditableConfigFromDisk(),
    modelMappings: validateModelMappings(modelMappings),
  }

  writeConfigToDisk(nextConfig)
  reloadConfig()
  return getModelMappings()
}

export function resolveMappedModel(model: string): string {
  return getModelMappings()[model] ?? model
}

export function getSmallModel(): string {
  return getSmallModelForProvider("copilot") ?? "gpt-6-luna"
}

export function getSmallModelForProvider(provider: string): string | undefined {
  const providerName = provider.trim()
  const configuredModels = getConfig().smallModels
  const model =
    configuredModels && Object.hasOwn(configuredModels, providerName) ?
      configuredModels[providerName]
    : defaultConfig.smallModels?.[providerName]

  return typeof model === "string" ? model.trim() || undefined : undefined
}

export function isContextManagementEnabledForMessages(): boolean {
  const config = getConfig()
  return config.contextManagement?.messages ?? defaultContextManagement.messages
}

export function isContextManagementEnabledForResponses(): boolean {
  const config = getConfig()
  return (
    config.contextManagement?.responses ?? defaultContextManagement.responses
  )
}

export function getModelResponsesApiCompactThreshold(
  model: string,
): number | undefined {
  const config = getConfig()
  const threshold = config.modelResponsesApiCompactThresholds?.[model]

  if (
    typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold <= 0
  ) {
    return undefined
  }

  return threshold
}

export function getReasoningEffortForModel(
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const config = getConfig()
  const userEffort = config.modelReasoningEfforts?.[model]
  if (userEffort !== undefined) {
    return userEffort
  }
  return isGpt53OrAbove(model) ? "xhigh" : "high"
}
