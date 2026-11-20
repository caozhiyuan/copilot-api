import consola from "consola"

import {
  copilotBaseUrl,
  copilotModelsHeaders,
} from "~/lib/providers/api-config"

import { HTTPError } from "~/lib/http/error"
import { state } from "~/lib/state"
import type { ModelsResponse } from "~/lib/types/models"

export const getModels = async () => {
  consola.info(`Fetching models from ${copilotBaseUrl(state)}/models`)
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotModelsHeaders(state),
  })

  if (!response.ok) {
    const errorText = await response.clone().text()

    consola.error("Failed to get models response body", errorText)

    throw new HTTPError("Failed to get models", response)
  }

  return (await response.json()) as ModelsResponse
}
