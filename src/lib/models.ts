import type { Model } from "~/lib/types/models"

import { state } from "~/lib/state"

export const findEndpointModel = (modelId: string): Model | undefined =>
  state.models?.data.find((model) => model.id === modelId)
