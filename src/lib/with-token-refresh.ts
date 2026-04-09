import consola from "consola"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { setupCopilotToken } from "~/lib/token"

/**
 * Wraps a fetch call with automatic Copilot token refresh on 401.
 *
 * If the initial response is 401:
 *   - Attempts to refresh the token via setupCopilotToken().
 *   - If refresh fails, throws an HTTPError wrapping the original 401 response
 *     so the caller sees a controlled upstream error, not the refresh failure.
 *   - If refresh succeeds, mutates headers["Authorization"] and retries once.
 *
 * Returns a Response that is guaranteed ok, or throws HTTPError.
 */
export const fetchWithCopilotTokenRefresh = async (
  doRequest: () => Promise<Response>,
  headers: Record<string, string>,
  errorLabel: string,
): Promise<Response> => {
  const response = await doRequest()

  if (!response.ok) {
    if (response.status === 401) {
      consola.warn("Copilot token expired, refreshing and retrying...")
      try {
        await setupCopilotToken()
      } catch (refreshError) {
        consola.error(
          `Failed to refresh Copilot token while retrying ${errorLabel}:`,
          refreshError,
        )
        throw new HTTPError(`Failed to ${errorLabel}`, response)
      }
      headers["Authorization"] = `Bearer ${state.copilotToken}`
      const retryResponse = await doRequest()
      if (!retryResponse.ok) {
        consola.error(
          `Failed to ${errorLabel} after token refresh`,
          retryResponse,
        )
        throw new HTTPError(`Failed to ${errorLabel}`, retryResponse)
      }
      return retryResponse
    }
    consola.error(`Failed to ${errorLabel}`, response)
    throw new HTTPError(`Failed to ${errorLabel}`, response)
  }

  return response
}
