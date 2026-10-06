import consola from "consola"

import { HTTPError } from "~/lib/error"

export const ASSISTANT_PREFILL_FALLBACK_TEXT =
  "Continue from where you left off."
const ASSISTANT_PREFILL_REJECTION_TEXT =
  "does not support assistant message prefill"

export const assistantPrefillState = {
  rejectingModels: new Set<string>(),
}

export const isAssistantPrefillRejection = async (
  error: unknown,
): Promise<boolean> => {
  if (!(error instanceof HTTPError) || error.response.status !== 400) {
    return false
  }
  try {
    const errorText = await error.response.clone().text()
    return errorText.includes(ASSISTANT_PREFILL_REJECTION_TEXT)
  } catch {
    return false
  }
}

interface AssistantPrefillFallbackOptions<T> {
  model: string
  endsOnAssistant: () => boolean
  applyFallback: () => void
  run: () => Promise<T>
}

export const withAssistantPrefillFallback = async <T>(
  options: AssistantPrefillFallbackOptions<T>,
): Promise<T> => {
  const { model, endsOnAssistant, applyFallback, run } = options
  if (!endsOnAssistant()) {
    return await run()
  }

  if (assistantPrefillState.rejectingModels.has(model)) {
    applyFallback()
    return await run()
  }

  try {
    return await run()
  } catch (error) {
    if (!(await isAssistantPrefillRejection(error))) {
      throw error
    }
    assistantPrefillState.rejectingModels.add(model)
    consola.info(
      `Model ${model} does not support assistant prefill; retrying without it and skipping prefill for this model from now on`,
    )
    applyFallback()
    return await run()
  }
}
