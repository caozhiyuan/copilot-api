import type { ResolvedProviderConfig } from "~/lib/config"
import type { ContentPart, Message } from "~/lib/types/chat-completions"

const OPENAI_COMPATIBLE_CONTEXT_CACHE_MARKER_LIMIT = 4
const OPENAI_COMPATIBLE_CONTEXT_CACHE_CONTROL = {
  type: "ephemeral",
} as const
const OPENAI_COMPATIBLE_CONTEXT_CACHE_ROLES = new Set<Message["role"]>([
  "system",
  "user",
  "assistant",
  "tool",
])

export const isDashScopeAliyunProvider = (
  providerConfig: ResolvedProviderConfig,
): boolean =>
  providerConfig.name === "dashscope"
  || providerConfig.baseUrl.includes("aliyuncs.com")

export const applyDashScopePreserveThinkingDefault = (
  payload: Record<string, unknown>,
  providerConfig: ResolvedProviderConfig,
): void => {
  if (!isDashScopeAliyunProvider(providerConfig)) {
    return
  }

  if (!Object.hasOwn(payload, "preserve_thinking")) {
    payload.preserve_thinking = true
  }
}

export const applyOpenAICompatibleContextCache = (payload: {
  messages: Array<Message>
  model: string
}): void => {
  if (payload.model.includes("/")) {
    return
  }
  if (!payload.model.toLowerCase().includes("qwen")) {
    return
  }
  const messageIndexes = selectContextCacheMessageIndexes(payload.messages)
  for (const messageIndex of messageIndexes) {
    applyContextCacheControl(payload.messages[messageIndex])
  }
}

const selectContextCacheMessageIndexes = (
  messages: Array<Message>,
): Array<number> => {
  const cacheableIndexes = messages.flatMap((message, index) =>
    isContextCacheMarkerEligible(message) ? [index] : [],
  )
  const systemIndexes = cacheableIndexes
    .filter((index) => messages[index]?.role === "system")
    .slice(0, 2)
  const finalIndexes = cacheableIndexes
    .filter((index) => messages[index]?.role !== "system")
    .slice(-1)
  return uniqueIndexes([...systemIndexes, ...finalIndexes]).sort(
    (a, b) => a - b,
  )
}

const uniqueIndexes = (indexes: Array<number>): Array<number> =>
  [...new Set(indexes)].slice(0, OPENAI_COMPATIBLE_CONTEXT_CACHE_MARKER_LIMIT)

const isContextCacheMarkerEligible = (message: Message): boolean => {
  if (!OPENAI_COMPATIBLE_CONTEXT_CACHE_ROLES.has(message.role)) {
    return false
  }

  if (typeof message.content === "string") {
    return message.content.length > 0
  }

  return Array.isArray(message.content) && message.content.length > 0
}

const applyContextCacheControl = (message: Message | undefined): void => {
  if (!message) {
    return
  }

  if (typeof message.content === "string") {
    message.content = [
      {
        type: "text",
        text: message.content,
        cache_control: { ...OPENAI_COMPATIBLE_CONTEXT_CACHE_CONTROL },
      },
    ]
    return
  }

  if (!Array.isArray(message.content)) {
    return
  }

  const lastPart = message.content.at(-1)
  if (!lastPart) {
    return
  }
  setContextCacheControl(lastPart)
}

const setContextCacheControl = (part: ContentPart): void => {
  part.cache_control = { ...OPENAI_COMPATIBLE_CONTEXT_CACHE_CONTROL }
}
