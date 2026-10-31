import { randomUUID } from "node:crypto"
import {
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici"

import { copilotBaseUrl } from "~/lib/api-config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { assertGitHubCopilotEnabled } from "~/lib/github-copilot-provider"
import { DEFAULT_IMAGE_MODELS } from "~/lib/image-models"
import { state } from "~/lib/state"
import { createTimeoutDispatcher } from "~/lib/timeout-dispatcher"

export const DEFAULT_COPILOT_IMAGE_MODEL =
  DEFAULT_IMAGE_MODELS["github-copilot"]

const COPILOT_CLIENT_VERSION = "copilot/1.0.103-unstable.r40031404408.gba6c003"
const COPILOT_IMAGES_TIMEOUT_MS = 15 * 60 * 1000
const copilotImagesDispatcher = createTimeoutDispatcher(
  COPILOT_IMAGES_TIMEOUT_MS,
)

export function resolveCopilotImagesUrl(
  requestUrl: string,
  operation: "generations" | "edits",
): string {
  const upstreamUrl = new URL(
    `${copilotBaseUrl(state).replace(/\/+$/u, "")}/v1/images/${operation}`,
  )
  if (upstreamUrl.hostname === "api.githubcopilot.com") {
    upstreamUrl.hostname = `api.${state.accountType}.githubcopilot.com`
  }
  upstreamUrl.search = new URL(requestUrl).search
  return upstreamUrl.toString()
}

export async function forwardCopilotImages(
  request: Request,
  operation: "generations" | "edits",
): Promise<Response> {
  assertGitHubCopilotEnabled()
  if (!state.githubToken) {
    throw new HTTPError(
      "GitHub token not found",
      Response.json(
        {
          error: {
            message: "GitHub token not found",
            type: "authentication_error",
          },
        },
        { status: 401 },
      ),
    )
  }

  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.githubToken}`,
      "content-type": "application/json",
      accept: request.headers.get("accept") ?? "application/json",
      "copilot-integration-id": "vscode-chat",
      "copilot-harness-id": "copilot-sdk",
      "editor-version": COPILOT_CLIENT_VERSION,
      "user-agent": `${COPILOT_CLIENT_VERSION} (${process.platform} unknown) term/unknown client/vscode-agent-host`,
      "openai-intent": "conversation-agent",
      "x-initiator": "agent",
      "x-github-api-version": "2026-08-01",
      "x-client-machine-id": state.vsCodeDeviceId,
      "x-interaction-id": randomUUID(),
    },
    body: request.body,
    duplex: "half",
    signal: AbortSignal.any([
      request.signal,
      AbortSignal.timeout(COPILOT_IMAGES_TIMEOUT_MS),
    ]),
  }
  const upstreamUrl = resolveCopilotImagesUrl(request.url, operation)
  const response =
    typeof Bun !== "undefined" ?
      await fetch(upstreamUrl, init)
    : ((await undiciFetch(upstreamUrl, {
        ...init,
        dispatcher: copilotImagesDispatcher,
      } as unknown as UndiciRequestInit)) as unknown as Response)
  logCopilotRateLimits(response.headers)
  return response
}
