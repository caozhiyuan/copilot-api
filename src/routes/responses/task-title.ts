import { getSmallModelForProvider } from "~/lib/config"
import type {
  ResponseInputMessage,
  ResponsesPayload,
} from "~/lib/types/responses"
import { isCodexUserAgent } from "~/routes/models/codex-models"
import consola from "consola"

const TASK_TITLE_PROMPT_PREFIX =
  "Generate a concise, single-line task title of at most 36 characters and under five words where possible."

export const taskTitleDependencies = { getSmallModelForProvider }

export const getCodexTaskTitleModel = (
  userAgent: string | undefined,
  input: ResponsesPayload["input"],
  provider: string,
): string | undefined => {
  if (!isCodexUserAgent(userAgent) || !Array.isArray(input)) return undefined

  const isTaskTitleRequest = input.slice(-2).some((item) => {
    const message = item as ResponseInputMessage
    return (
      message?.role === "user"
      && Array.isArray(message.content)
      && message.content.some(
        (part) =>
          part?.type === "input_text"
          && typeof part.text === "string"
          && part.text.startsWith(TASK_TITLE_PROMPT_PREFIX),
      )
    )
  })

  if (!isTaskTitleRequest) return undefined

  const model = taskTitleDependencies.getSmallModelForProvider(provider)
  if (model) {
    consola.debug(`Codex task title small model: ${provider} -> ${model}`)
  }
  return model
}
