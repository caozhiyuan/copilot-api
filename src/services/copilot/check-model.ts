import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { state } from "~/lib/state"

/**
 * Probes the availability of a model by sending a minimal chat completion request.
 * Returns true if the model is available (200 OK), false otherwise.
 */
export async function checkModelAvailability(modelId: string): Promise<boolean> {
  if (!state.copilotToken) return false

  try {
    const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
      method: "POST",
      headers: {
        ...copilotHeaders(state),
        "x-initiator": "user",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
    })

    return response.ok
  } catch {
    return false
  }
}
