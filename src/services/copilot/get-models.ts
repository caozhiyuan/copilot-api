import fs from "node:fs/promises"

import type { AccountContext } from "~/lib/types/account"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"
import { accountFromState } from "~/lib/state"

export const getModels = async (account?: AccountContext) => {
  const ctx = account ?? accountFromState()
  const response = await fetch(`${copilotBaseUrl(ctx)}/models`, {
    headers: copilotHeaders(ctx),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  const models = (await response.json()) as ModelsResponse

  // Persist models response for debugging/inspection.
  // Best effort: do not fail startup if the local write fails.
  try {
    await fs.mkdir(PATHS.APP_DIR, { recursive: true })
    await fs.writeFile(
      PATHS.MODELS_PATH,
      `${JSON.stringify(models, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    )
  } catch {
    // ignore
  }

  return models
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  max_thinking_budget?: number
  min_thinking_budget?: number
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  structured_outputs?: boolean
  vision?: boolean
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

interface ModelBilling {
  is_premium?: boolean
  multiplier?: number
}

export interface Model {
  billing?: ModelBilling
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  supported_endpoints?: Array<string>
}
